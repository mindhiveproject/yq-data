# yq-data

Capture, process and record physiological data in the browser.

`yq-data` connects to biosignal hardware (EEG headsets, cameras, microphones, LSL relays). It's basically a single interface in graph format to connect to, process, and analyze biosignal hardware. It's a sort of SDK and connection helper for other web applications.

```bash
npm install @mindhive_science/yq-data
```

## Quick start

How to connect a Muse, filter the EEG, and read band power:

```ts
import {
  MuseReceiver,
  Pipeline,
  AnalysisMethod,
  Modality,
} from "@mindhive_science/yq-data";

const muse = new MuseReceiver();
await muse.connect(); // shows the browser's Bluetooth picker, so call it from a click handler
await muse.startStream();

const pipeline = new Pipeline({
  nodes: [
    { id: "eeg", receiver: "muse", stream: Modality.EEG },
    {
      id: "filter",
      method: AnalysisMethod.FILTERING,
      parameters: { kind: "bandpass", cutoff: [1, 45] },
    },
    {
      id: "window",
      method: AnalysisMethod.WINDOWING,
      parameters: { size: 2, hop: 0.1 },
    },
    { id: "bands", method: AnalysisMethod.BAND_POWER, label: "Band power" },
  ],
  edges: [
    { from: ["eeg"], to: ["filter"] },
    { from: ["filter"], to: ["window"] },
    { from: ["window"], to: ["bands"] },
  ],
});

pipeline.attachReceiver("muse", muse);
pipeline.start();

pipeline.getOutput("bands").subscribe((packet) => {
  // channels are labelled Delta, Theta, Alpha, Low beta, High beta, Gamma
});
```

A **receiver** connects to a source and publishes data. A **pipeline** is a graph of analyzers that processes it. The graph is plain JSON, so a processing chain can be stored in a database and rehydrated without any code.

You can also replay recordings rather than connecting to hardware, see: [Record and replay](#record-and-replay).

## Data format

One unified packet type travels through receivers, analyzers and transports:

```ts
interface DataPacket {
  streamID: string; // i.e. "muse-4B2C:eeg:features:band_power"
  timestamp: number; // ms since epoch, host clock
  data: Float32Array; // sample-interleaved flat array
  labels?: string[]; // categorical value per sample, mainly for marker streams
  metadata: StreamMetadata;
  deviceTime?: number; // if available, the device's own clock
}
```

**Stream IDs** are `deviceID:modality:processingStage[:name]`. **Payloads are sample-interleaved**: for a stream with `channelCount = C`, sample `i` of channel `c` lives at `data[i * C + c]`. The `getChannel`, `deinterleave` and `interleave` helpers do this for you. [More on the data format](https://github.com/mindhiveproject/yq-data/blob/main/docs/data-format.md).

## Receivers

| Receiver               | Source                                                                                                                        | Notes                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MuseReceiver`         | Muse 2, classic Muse S, [Muse S Athena](https://github.com/mindhiveproject/yq-data/blob/main/docs/receivers.md#muse-s-athena) | Web Bluetooth. Raw EEG at 256 Hz, PPG at 64 Hz; motion at 52 Hz on an Athena                                                                                      |
| `EMOTIVReceiver`       | EMOTIV headsets                                                                                                               | Cortex API over WebSocket; needs credentials                                                                                                                      |
| `LSLReceiver`          | Lab Streaming Layer                                                                                                           | Via a [WebSocket relay](https://github.com/mindhiveproject/yq-data/blob/main/docs/receivers.md#lab-streaming-layer); reads the `lsl` protocol; auto-reconnects    |
| `ArduinoReceiver`      | Arduino, ESP32, other [microcontrollers](https://github.com/mindhiveproject/yq-data/blob/main/docs/microcontrollers.md)       | Web Serial or Web Bluetooth. The board announces its own streams; also writes to the board                                                                        |
| `MicrophoneReceiver`   | Microphone                                                                                                                    | AudioWorklet; raw interleaved PCM                                                                                                                                 |
| `VideoReceiver`        | Camera                                                                                                                        | Lifecycle handle only — emits no packets                                                                                                                          |
| `FaceLandmarkReceiver` | Camera                                                                                                                        | 52 expression scores (`blendshapes`), head pose; opt-in face box and 478 landmarks                                                                                |
| `FaceEmotionReceiver`  | Camera                                                                                                                        | 7 facial expression probabilities; opt-in face box and landmarks                                                                                                  |
| `PoseReceiver`         | Camera                                                                                                                        | 33 body landmarks                                                                                                                                                 |
| `RPPGReceiver`         | Camera                                                                                                                        | Mean skin colour (R, G, B) of forehead and cheeks, for [heart rate](https://github.com/mindhiveproject/yq-data/blob/main/docs/camera.md#heart-rate-from-a-camera) |
| `MarkerReceiver`       | Your own code                                                                                                                 | Timed [event markers](https://github.com/mindhiveproject/yq-data/blob/main/docs/receivers.md#event-markers); no device to connect                                 |
| `VoiceEmotionReceiver` | Microphone                                                                                                                    | 4 speech emotion probabilities, per phrase                                                                                                                        |
| `FileReplayReceiver`   | A recording                                                                                                                   | No hardware, no permissions, no network                                                                                                                           |
| `RemoteStreamReceiver` | Another context                                                                                                               | Streams sent in over a `Transport` — a tab, a worker, a server                                                                                                    |

Every receiver exposes `connect`, `startStream`, `stopStream`, `disconnect`, an `isConnected$` observable, a merged `data` observable, and `getData(stream)` for one specific stream. To build receivers from a stored type name rather than code, use `createReceiver("muse")`; see [Receivers](https://github.com/mindhiveproject/yq-data/blob/main/docs/receivers.md).

## Pipelines

Each node in a graph is a receiver or an analyzer (filtering, windowing, band power, heart rate, correlation, and more). Analyzers declare what they accept, so a graph can be checked before any data flows, which is what lets a node editor refuse a bad edge while the user is still dragging it:

```ts
pipeline.issues(); // every problem it can prove, with a severity
pipeline.describe(); // the streams each output will carry, before any data arrives
```

See [Pipelines](https://github.com/mindhiveproject/yq-data/blob/main/docs/pipelines.md) for outputs, validation, routing and multi-input nodes, and [Analyzers](https://github.com/mindhiveproject/yq-data/blob/main/docs/analyzers.md) for the full list, plus how to use the processing directly without a pipeline.

## Record and replay

`Recorder` captures any receiver or pipeline output to a zip of CSVs, and `FileReplayReceiver` plays it back as if it were the live device:

```ts
const recorder = new Recorder();
recorder.addReceiver(muse);
recorder.start();
// ...later
recorder.stop();
await recorder.download();
```

```ts
const replay = new FileReplayReceiver({ loop: true });
await replay.connect(zipFileOrURL);
replay.startStream();
replay.data.subscribe(handler);
```

More in [Record and replay](https://github.com/mindhiveproject/yq-data/blob/main/docs/record-and-replay.md).

## Sending streams elsewhere

`StreamTransmitter` sends any receiver or pipeline output to another context (another tab, a server, a microcontroller) over a `Transport`, and `RemoteStreamReceiver` is the other end. A transmit or receive endpoint can also be a node in a pipeline graph. See [Sending streams: transports and protocols](https://github.com/mindhiveproject/yq-data/blob/main/docs/transports-and-protocols.md).

## More documentation

- [Data format](https://github.com/mindhiveproject/yq-data/blob/main/docs/data-format.md): metadata, categorical streams
- [Receivers](https://github.com/mindhiveproject/yq-data/blob/main/docs/receivers.md): markers, Muse S Athena, LSL, emotion
- [Camera receivers](https://github.com/mindhiveproject/yq-data/blob/main/docs/camera.md): one camera for several analyses, heart rate from video, drawing faces
- [Microcontrollers](https://github.com/mindhiveproject/yq-data/blob/main/docs/microcontrollers.md): Arduino and ESP32 over serial or Bluetooth
- [Pipelines](https://github.com/mindhiveproject/yq-data/blob/main/docs/pipelines.md) and [Analyzers](https://github.com/mindhiveproject/yq-data/blob/main/docs/analyzers.md)
- [Record and replay](https://github.com/mindhiveproject/yq-data/blob/main/docs/record-and-replay.md)
- [Sending streams: transports and protocols](https://github.com/mindhiveproject/yq-data/blob/main/docs/transports-and-protocols.md)
- [Performance](https://github.com/mindhiveproject/yq-data/blob/main/docs/performance.md): what a session costs, and how to measure it
- [References and attribution](https://github.com/mindhiveproject/yq-data/blob/main/docs/references.md)

## Dependencies

Runtime dependencies are `rxjs` and `muse-jsx`.

Six packages are **optional peer dependencies**, dynamically imported only when a feature that needs them is used. An application that only talks to a Muse, for example, doesn't need to download MediaPipe:

| Package                   | Needed for                                             |
| ------------------------- | ------------------------------------------------------ |
| `@mediapipe/tasks-vision` | `FaceLandmarkReceiver`, `PoseReceiver`, `RPPGReceiver` |
| `@vladmandic/face-api`    | `FaceEmotionReceiver`                                  |
| `formantanalyzer`         | `VoiceEmotionReceiver`                                 |
| `jszip`                   | `Recorder`, `FileReplayReceiver`                       |
| `papaparse`               | `FileReplayReceiver`                                   |
| `@msgpack/msgpack`        | `ArduinoReceiver` (`msgpackCodec`)                     |

Model weights are fetched at connect time rather than bundled, so nothing large ships in the tarball. Every receiver that loads a model accepts a path option (`modelAssetPath`, `modelPath`) for applications that would rather self-host than reach a CDN. The voice emotion classifier ships in this package's `models/` folder and is fetched from this version on npm; the rest come from their upstream projects.

## Browser requirements

Everything runs in a single document — no popup windows are needed for any source. All of it requires a secure context (`https://` or `localhost`):

- **Web Bluetooth** (Muse, `BluetoothTransport`) — Chrome, Edge, Opera. Not Safari or Firefox.
- **Web Serial** (`SerialTransport`) — Chrome, Edge, Opera. Not Safari or Firefox.
- **getUserMedia** (camera, microphone) — all modern browsers.
- **AudioWorklet** (microphone) — all modern browsers.
- **EMOTIV** additionally needs the Cortex service running locally, and its self-signed certificate at `wss://localhost:6868` accepted once.

## Development

```bash
npm install
npm run build      # tsup -> dist/ (CJS, ESM, .d.ts)
npm test           # jest: unit tests and the golden-value suite
npm run golden     # just the golden-value suite, one line per case
npm run bench      # what a session costs on this machine

cd demos && npm install && npm run dev
```

The golden suite holds the DSP to SciPy, YASA, NeuroKit2 and the authors' own reference code; its [README](https://github.com/mindhiveproject/yq-data/blob/main/tests/unit/golden/README.md) covers how the reference values are produced and how to add a method. `npm run bench` takes a section name to run only that part: `dsp`, `chains`, `pipeline` or `io`; see [Performance](https://github.com/mindhiveproject/yq-data/blob/main/docs/performance.md).

The demo app is the fastest harness for working on a receiver: it aliases `yq-data` straight to `src/`, so edits appear on save with no rebuild. Its recording-replay panel needs no hardware at all.
