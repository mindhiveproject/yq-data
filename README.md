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
| `LSLReceiver` | Lab Streaming Layer | Via a [WebSocket relay](#lab-streaming-layer); auto-reconnects |
| `MicrophoneReceiver` | Microphone | AudioWorklet; raw interleaved PCM |
| `VideoReceiver` | Camera | Lifecycle handle only — emits no packets |
| `FaceLandmarkReceiver` | Camera | 52 expression scores, head pose, landmarks |
| `FaceEmotionReceiver` | Camera | 7 facial expression probabilities |
| `PoseReceiver` | Camera | 33 body landmarks |
| `RPPGReceiver` | Camera | Pulse-bearing RGB signal from facial skin |
| `VoiceEmotionReceiver` | Microphone | 4 speech emotion probabilities, per phrase |
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
const emotion = new FaceEmotionReceiver(videoElement);
const pulse = new RPPGReceiver(videoElement);
```

The element must stay mounted while streaming. In a React app, mount it once
outside the panel tree and portal previews into it — unmounting it when a tab
changes kills the camera and every derived stream.

### Emotion

Two receivers infer emotion, and they answer different questions.

`FaceEmotionReceiver` runs face-api's expression network over the camera and
emits seven probabilities summing to 1 — `neutral`, `happy`, `sad`, `angry`,
`fearful`, `disgusted`, `surprised` — at the configured frame rate. It defaults
to the 190 KB `tiny` face detector; pass `detector: "ssd"` for the slower,
more accurate SSD-MobileNet.

```ts
const emotion = new FaceEmotionReceiver(videoElement, { maxFps: 10 });
await emotion.connect();
emotion.startStream();
```

`VoiceEmotionReceiver` listens to the microphone, segments speech into
syllables, and scores each phrase as `N` neutral, `A` angry, `S` sad or `H`
happy. It opens its own microphone, so it runs independently of
`MicrophoneReceiver` and both can be connected at once.

```ts
const voice = new VoiceEmotionReceiver({ emitAffect: true });
await voice.connect();
await voice.startStream();
```

**It emits per phrase, not per interval.** Nothing arrives while nobody is
speaking, and its streams therefore carry no `samplingRate`. Bind it to
something that tolerates gaps.

`emitAffect` adds a second stream carrying `valence` and `arousal`, computed
from a time-smoothed distribution with the formula the old You-Quantified
popup used — `valence = 3 × H`, `arousal = 1 − N`. It exists so visuals built
against that device keep working; valence is deliberately **not** bounded by 1.
New work should bind to the class probabilities directly.

Both models are trained on posed, frontal, well-lit faces and on acted or
podcast speech. Treat their output as expressive rather than diagnostic.

### Lab Streaming Layer

LSL is a native protocol with no browser binding, so `LSLReceiver` does not
talk to LSL directly — it connects to a relay running on the machine the
streams are on, which forwards them as JSON over a WebSocket:

```ts
const lsl = new LSLReceiver();
await lsl.connect("ws://localhost:8080");
```

[LSLWebsocketMirror](https://github.com/esromerog/LSLWebsocketMirror) is a
Python script that does this. Any relay emitting the same message shape works
— `{ "<streamKey>": { info, timeseries, timestamp } }`, `info` on the first
message for a stream — so an existing bridge can be pointed at this instead.

One relay commonly carries several devices; each LSL stream becomes its own
yq-data stream, keyed by `source_id`.

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

`HeartRate` detects beats with the adaptive-threshold method of Shin, Lee & Lee
(2009) — see [References](#references) — and derives the rate from the median
inter-beat interval. Its `spectral` strategy skips detection entirely and takes
the dominant frequency of the pulse band, which is steadier on camera-derived
rPPG but reports no variability.

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

## References and attribution

Methods:

- Shin, H.S., Lee, C. & Lee, M. (2009). Adaptive threshold method for the peak
  detection of photoplethysmographic waveform. *Computers in Biology and
  Medicine*, 39(12), 1145–1152.
  [doi:10.1016/j.compbiomed.2009.10.006](https://doi.org/10.1016/j.compbiomed.2009.10.006)
  — the peak detector and the 15-tap FIR lowpass behind `HEART_RATE`.
- Lugaresi, C., Tang, J., Nash, H., McClanahan, C., Uboweja, E., Hays, M.,
  Zhang, F., Chang, C.-L., Yong, M.G., Lee, J., Chang, W.-T., Hua, W., Georg, M.
  & Grundmann, M. (2019). MediaPipe: A Framework for Building Perception
  Pipelines. [arXiv:1906.08172](https://arxiv.org/abs/1906.08172) — the
  framework behind `FaceLandmarkReceiver`, `PoseReceiver`, and the face
  tracking that places the region of interest in `RPPGReceiver`.
- Rouast, P.V., Adam, M.T.P., Cornforth, D.J., Lux, E. & Weinhardt, C. (2016).
  Using Contactless Heart Rate Measurements for Real-Time Assessment of
  Affective States. In *Information Systems and Neuroscience*, LNISO 10,
  157–163.
  [doi:10.1007/978-3-319-41402-7_20](https://doi.org/10.1007/978-3-319-41402-7_20)
  — the rPPG approach `RPPGReceiver` follows, implemented in
  [heartbeat-js](https://github.com/prouast/heartbeat-js).

Software this package builds on:

| Project | Used by |
|---|---|
| [muse-js](https://github.com/urish/muse-js) | `MuseReceiver` — Bluetooth GATT over Web Bluetooth |
| [Cortex API](https://emotiv.gitbook.io/cortex-api) | `EMOTIVReceiver` — proprietary, needs EMOTIV's local software |
| [MediaPipe Tasks](https://ai.google.dev/edge/mediapipe) | `FaceLandmarkReceiver`, `PoseReceiver`, `RPPGReceiver` |
| [face-api.js](https://github.com/justadudewhohacks/face-api.js) | `FaceEmotionReceiver`, via the maintained [`@vladmandic` fork](https://github.com/vladmandic/face-api) |
| [Lab Streaming Layer](https://labstreaminglayer.readthedocs.io) | `LSLReceiver`, through [LSLWebsocketMirror](https://github.com/esromerog/LSLWebsocketMirror) |
| [ml5.js](https://ml5js.org) | `VoiceEmotionReceiver` — model format; the forward pass is this package's |
| [formantanalyzer](https://github.com/tabahi/formantanalyzer.js) | `VoiceEmotionReceiver` — syllable segmentation and formant features |

## Dependencies

Runtime dependencies are `rxjs`, `muse-js` and `mathjs`. mathjs is imported
through its factory entry points so a bundler tree-shakes everything but the
FFT, and it is confined to `analyzer/methods/fft.ts`.

Five packages are **optional peer dependencies**, dynamically imported only
when a feature that needs them is used. An application that only talks to a Muse
never downloads MediaPipe:

| Package | Needed for |
|---|---|
| `@mediapipe/tasks-vision` | `FaceLandmarkReceiver`, `PoseReceiver`, `RPPGReceiver` |
| `@vladmandic/face-api` | `FaceEmotionReceiver` |
| `formantanalyzer` | `VoiceEmotionReceiver` |
| `jszip` | `Recorder`, `FileReplayReceiver` |
| `papaparse` | `FileReplayReceiver` |

Model weights are fetched at connect time rather than bundled, so nothing large
ships in the tarball. Every receiver that loads a model accepts a path option
(`modelAssetPath`, `modelPath`) for applications that would rather self-host
than reach a CDN. The voice emotion classifier lives in `models/` in this
repository; the rest come from their upstream projects.

`VoiceEmotionReceiver` runs the classifier itself rather than through
TensorFlow.js — it is a 30k-parameter dense stack, and `ML5Classifier` reads
ml5's saved format and does the forward pass directly, verified against
TensorFlow.js in `tests/unit/ml5_model.test.ts`.

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
