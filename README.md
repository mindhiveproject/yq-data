# yq-data

Capture, process and record physiological data in the browser.

`yq-data` connects to biosignal hardware — EEG headsets, cameras, microphones,
LSL relays — normalizes everything into a single packet format, and runs
declarative processing graphs over it. It knows nothing about any particular
application: it produces named streams of numbers with enough metadata to
describe themselves, and stops there.

```bash
npm install yq-data
```

## The shape of everything

One type carries all data, from a raw electrode to an inferred heart rate:

```ts
interface DataPacket {
  streamID: string;        // "muse-4B2C:eeg:features:band_power"
  timestamp: number;       // ms since epoch, host clock
  data: Float32Array;      // sample-interleaved
  metadata: StreamMetadata;
  deviceTime?: number;     // the device's own clock, when it keeps one
}
```

**Stream IDs** are `deviceID:modality:processingStage[:name]`. They are the
addressing scheme for the whole package — a mapping elsewhere in a system needs
only a stream ID and a channel index to identify any value.

**Payloads are sample-interleaved.** For a stream with `channelCount = C`,
sample `i` of channel `c` lives at `data[i * C + c]`. This is the layout LSL,
Web Audio and WAV already use, so most sources forward without a copy. Use the
helpers rather than assuming the layout:

```ts
import { getChannel, deinterleave, interleave } from "yq-data";

const af7 = getChannel(packet, 1);           // one dense channel
const all = deinterleave(packet.data, 4);    // every channel
const packed = interleave([left, right]);    // back to interleaved
```

**Metadata travels with the data.** `channelInfo` gives every channel a label
and unit, and `processingHistory` accumulates a record of every analyzer a
packet passed through, so a value arriving at the far end of a graph can still
explain where it came from.

## Receivers

A receiver owns a connection to one source and publishes packets.

| Receiver | Source | Notes |
|---|---|---|
| `MuseReceiver` | Muse headband | Web Bluetooth. Raw EEG at 256 Hz, PPG at 64 Hz |
| `EMOTIVReceiver` | EMOTIV headsets | Cortex API over WebSocket; needs credentials |
| `LSLReceiver` | Lab Streaming Layer | Via a WebSocket relay; auto-reconnects |
| `MicrophoneReceiver` | Microphone | AudioWorklet; raw interleaved PCM |
| `VideoReceiver` | Camera | Lifecycle handle only — emits no packets |
| `FaceLandmarkReceiver` | Camera | 52 expression scores, head pose, landmarks |
| `PoseReceiver` | Camera | 33 body landmarks |
| `RPPGReceiver` | Camera | Pulse-bearing RGB signal from facial skin |
| `FileReplayReceiver` | A recording | No hardware, no permissions, no network |

```ts
import { MuseReceiver } from "yq-data";

const muse = new MuseReceiver();
await muse.connect();
await muse.startStream();

muse.data.subscribe((packet) => console.log(packet.streamID, packet.data));
```

Every receiver exposes `connect`, `startStream`, `stopStream`, `disconnect`, an
`isConnected$` observable, a merged `data` observable, and `getData(stream)` for
one specific stream.

### One camera, several analyses

`VideoReceiver` owns the camera and the `<video>` element; the vision receivers
read pixels from that same element. This is why face tracking and heart rate can
run together without opening the camera twice:

```ts
const camera = new VideoReceiver(videoElement);
await camera.connect();
await camera.startStream();

const face = new FaceLandmarkReceiver(videoElement);
const pulse = new RPPGReceiver(videoElement);
```

The element must stay mounted while streaming. In a React app, mount it once
outside the panel tree and portal previews into it — unmounting it when a tab
changes kills the camera and every derived stream.

## Pipelines

A `Pipeline` runs a graph of analyzers over connected receivers. The graph is
plain JSON, so a processing chain can be stored in a database and rehydrated
without any code:

```ts
import { Pipeline, AnalysisMethod, Modality } from "yq-data";

const pipeline = new Pipeline({
  nodes: [
    { id: "eeg",    receiver: "muse", stream: Modality.EEG },
    { id: "clean",  method: AnalysisMethod.FILTERING,  parameters: { kind: "bandpass", cutoff: [1, 45] } },
    { id: "window", method: AnalysisMethod.WINDOWING,  parameters: { size: 2, hop: 0.1 } },
    { id: "bands",  method: AnalysisMethod.BAND_POWER, label: "Band power" },
  ],
  edges: [
    { from: ["eeg"],    to: ["clean"]  },
    { from: ["clean"],  to: ["window"] },
    { from: ["window"], to: ["bands"]  },
  ],
});

pipeline.attachReceiver("muse", muse);
pipeline.start();

pipeline.getOutput("bands").subscribe((packet) => {
  // channels are labelled Delta, Theta, Alpha, Low beta, High beta, Gamma
});
```

Receivers can be attached before or after `start()`, which matters because a
user connects their headset long after the graph was built. Cyclic graphs and
unknown methods are rejected at construction rather than failing at runtime.

### Windowing is explicit

Devices deliver signal in whatever chunk their transport dictates — Muse sends
12 EEG samples at a time — while spectral analysis needs a window of a second or
more. `Windowing` is a node in the graph rather than hidden inside each
analyzer, which keeps every downstream analyzer stateless and makes the window
length a visible property of the pipeline. Anything spectral needs one upstream.

### Available analyzers

| Method | Class | Does |
|---|---|---|
| `WINDOWING` | `Windowing` | Buffers into fixed, optionally overlapping windows |
| `FILTERING` | `Filtering` | Butterworth low/high/band/stop, stateful across packets |
| `NORMALIZATION` | `Normalization` | Min-max, z-score, fixed range, or a decaying running range |
| `CHANNEL_SELECTION` | `ChannelSelection` | Pick or average channels by index or label |
| `FFT` / `PSD` | `SpectrumAnalyzer` | Per-channel spectrum |
| `BAND_POWER` | `BandPower` | Power in named frequency bands |
| `STATISTICAL_FEATURES` | `StatisticalFeatures` | Mean, std, RMS, min, max, range |
| `RMS` | `RMSAnalyzer` | Amplitude, linear or dBFS |
| `HEART_RATE` | `HeartRate` | BPM from a pulse waveform, plus HRV |
| `CONNECTIVITY` | `Correlation` | Correlation between two streams |
| `difference` | `Difference` | Element-wise comparison — facial synchrony |

Register your own with `registerAnalyzer(method, factory)`; built-in and custom
nodes execute through the same evaluator.

### Multi-input nodes

`Correlation` and `Difference` extend `MultiInputAnalyzer`, which takes several
named ports. Edges route to a port by name:

```ts
edges: [
  { from: ["headset-a"], to: ["synchrony", "a"] },
  { from: ["headset-b"], to: ["synchrony", "b"] },
]
```

Ports pair by `syncPolicy`: `"latest"` (default) emits on every packet using the
last value seen on each other port; `"timestamp"` waits until every port has a
packet within `tolerance` ms — appropriate only for sources that share a clock.

## Record and replay

`Recorder` writes a zip of CSVs that `FileReplayReceiver` reads back. Capture a
real session once and develop against it forever:

```ts
const recorder = new Recorder();
recorder.addReceiver(muse);
recorder.start();
// ...later
recorder.stop();
await recorder.download();     // yq_rec_20260814T1530.zip
```

```ts
const replay = new FileReplayReceiver({ loop: true, speed: 1 });
await replay.connect(zipFileOrURL);
replay.startStream();
replay.data.subscribe(handler);   // behaves exactly like the live device
```

Tracks recorded at different rates are advanced against one shared clock, so a
256 Hz EEG track and a 10 Hz feature track stay aligned during playback.

## Working with the DSP directly

Everything under `analyzer/methods` is a pure function over plain arrays, usable
without any packet, receiver or pipeline:

```ts
import { spectrum, bandAverage, designFilter, filtfiltCascade } from "yq-data";

const sections = designFilter({ kind: "bandpass", cutoff: [1, 40], samplingRate: 256, order: 4 });
const clean = filtfiltCascade(sections, signal);
const spec = spectrum(clean, { samplingRate: 256, window: "hamming" });
const alpha = bandAverage(spec, 8, 12);
```

## Dependencies

Runtime dependencies are `rxjs`, `muse-js` and `mathjs`. mathjs is imported
through its factory entry points so a bundler tree-shakes everything but the
FFT, and it is confined to `analyzer/methods/fft.ts`.

Three packages are **optional peer dependencies**, dynamically imported only
when a feature that needs them is used. An application that only talks to a Muse
never downloads MediaPipe:

| Package | Needed for |
|---|---|
| `@mediapipe/tasks-vision` | `FaceLandmarkReceiver`, `PoseReceiver`, `RPPGReceiver` |
| `jszip` | `Recorder`, `FileReplayReceiver` |
| `papaparse` | `FileReplayReceiver` |

## Browser requirements

Everything runs in a single document — no popup windows are needed for any
source. All of it requires a secure context (`https://` or `localhost`):

- **Web Bluetooth** (Muse) — Chrome, Edge, Opera. Not Safari or Firefox.
- **getUserMedia** (camera, microphone) — all modern browsers.
- **AudioWorklet** (microphone) — all modern browsers.
- **EMOTIV** additionally needs the Cortex service running locally, and its
  self-signed certificate at `wss://localhost:6868` accepted once.

## Development

```bash
npm install
npm run build      # tsup -> dist/ (CJS, ESM, .d.ts)
npm test           # jest unit tests
npm run test:e2e   # puppeteer

cd demos && npm install && npm run dev
```

The demo app is the fastest harness for working on a receiver: it aliases
`yq-data` straight to `src/`, so edits appear on save with no rebuild. Its
recording-replay panel needs no hardware at all.
