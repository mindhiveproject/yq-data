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
  labels?: string[];       // categorical value per sample, for marker streams
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

**Almost every stream is numeric.** `labels` is the exception: event markers
set it, and so would a classifier emitting a decision rather than scores. A
classifier emitting *scores* needs nothing special — score-per-class is an
ordinary multi-channel packet whose classes are named by `channelInfo`. A
stream declares which it is with `metadata.valueType`, which is `"numeric"`
unless it says otherwise and `"categorical"` when the value is the label and
the number beside it only a code. Because it is declared on the stream, a
graph can be checked before any data flows.

## Event markers

`MarkerReceiver` is a stream of timed events pushed in by whatever code runs
alongside the pipeline. It is the bridge to an experiment: a jsPsych trial
marks its own onset, and that marker lands on the same clock, in the same
recording, as the EEG beside it.

```ts
import { MarkerReceiver } from "yq-data";

const markers = new MarkerReceiver();
markers.connect();

// in a jsPsych trial
on_start: () => markers.mark("stimulus_onset", { timestamp: Date.now() }),
```

Pass `timestamp` captured at the event itself wherever you can. `mark()` will
stamp the moment it is called, but that is already after whatever ran between
the event and the call.

Each marker is one sample: the string in `labels`, and a numeric code in `data`
assigned per distinct label so a CSV column and any numeric consumer still see
something sensible. `Recorder` writes markers as their own CSV with a `label`
column, which means a session can be epoched offline in MNE or R straight from
the exported archive.

Markers are irregular, so the stream carries no `samplingRate` — and that,
together with `valueType: "categorical"`, is what keeps them out of analyzers
that would quietly average or filter marker codes into a meaningless number.
An analyzer opts in with `accepts.valueTypes`, which defaults to `["numeric"]`.
See [compatibility](#compatibility) below.

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
| `MarkerReceiver` | Your own code | Timed [event markers](#event-markers); no device to connect |
| `VoiceEmotionReceiver` | Microphone | 4 speech emotion probabilities, per phrase |
| `FileReplayReceiver` | A recording | No hardware, no permissions, no network |
| `RemoteStreamReceiver` | Another context | Streams sent in over a `Transport` — a tab, a worker, a server |

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
yq-data stream, keyed by `source_id`. Use `StreamSelection` to pull individual
streams off that shared wire — see [routing](#routing-splitting-and-joining-wires).

An LSL stream of type `Markers` becomes exactly the same shape a
`MarkerReceiver` produces: `valueType: "categorical"`, no sampling rate, one
label per sample with a numeric code assigned per distinct label. LSL marker
outlets declare a string channel format, which is the one format ordinary
streams reject, so markers are the deliberate exception to that rule. An
experiment marking trials from PsychoPy over LSL is indistinguishable
downstream from one calling `mark()` in the page.

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

### Compatibility

Every analyzer declares what it will accept as data, not as a predicate:

```ts
readonly accepts: Accepts = { requiresSamplingRate: true };
```

That declaration is checked against `StreamMetadata`, which a receiver
publishes when it registers a stream — before any packet arrives. So the
question a node editor needs answered ("may I draw this edge?") can be answered
while the user is still dragging it:

```ts
import { canConnect, compatibleMethods, registeredMethods } from "yq-data";

canConnect(markerMeta, AnalysisMethod.BAND_POWER);
//=> 'stream "markers:event_marker:raw" carries labels rather than
//    measurements, which this node cannot interpret'

compatibleMethods(eegMeta, registeredMethods());
//=> ["filtering", "windowing", "band_power", ...]
```

A whole graph can be checked at once. `issues()` returns every problem it can
prove — an unconnected input port, or a port fed by a stream its node cannot
read — and `validate()` throws with the full list rather than one error per
edit-and-rerun cycle:

```ts
pipeline.attachReceiver("markers", markers);
pipeline.validate();
// Error: Pipeline graph has 1 compatibility problem:
//   - "power" port "in": stream "markers:event_marker:raw" carries labels ...
```

Because a source can put several streams on one wire, an edge is judged on the
set it carries rather than one stream at a time, and each issue says how much it
costs. Nothing usable is an `"error"` — that node will never emit. Some usable
is a `"warning"`: the graph runs on the rest, which is the ordinary shape of a
fat wire and matches what the runtime does with it. `validate()` throws on
errors only; read `issues()` to show warnings.

```ts
pipeline.issues();
//=> [{ nodeId: "power", port: "in", severity: "warning",
//      reason: '1 of 2 streams on this edge will be dropped: stream
//               "psychopy-1:event_marker:raw" carries labels rather than ...' }]
```

Validation judges what is knowable. A transforming node's output metadata is
unknown until it has emitted once, so edges below a silent analyzer are checked
at runtime instead, on the first packet through each port. Routing nodes are the
exception: `StreamSelection` forwards packets untouched, so what leaves it is
what reached it minus what it drops, and the pipeline resolves that statically —
which is what makes the edge on the far side of a selector exactly checkable
before any data flows. A port that fails at runtime is dropped and reported
through `onError`; one bad edge should not take down the streams that work.

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
| `STREAM_SELECTION` | `StreamSelection` | Passes some streams off a shared wire, drops the rest |
| `MERGE` | `Merge` | Joins several streams into one multi-channel stream |

Register your own with `registerAnalyzer(method, factory)`; built-in and custom
nodes execute through the same evaluator.

`HeartRate` detects beats with the adaptive-threshold method of Shin, Lee & Lee
(2009) — see [References](#references) — and derives the rate from the median
inter-beat interval. Its `spectral` strategy skips detection entirely and takes
the dominant frequency of the pulse band, which is steadier on camera-derived
rPPG but reports no variability.

### Routing: splitting and joining wires

A source node that names no `stream` forwards **everything** its receiver
produces — a Muse puts EEG, PPG and motion on one wire; an LSL relay puts the
whole lab on one. `StreamSelection` pulls those apart again downstream, and
`Merge` joins wires back together:

```ts
nodes: [
  { id: "device", receiver: "muse" },                                  // everything
  { id: "eeg",    method: AnalysisMethod.STREAM_SELECTION,
    parameters: { modalities: [Modality.EEG] } },
  { id: "pulse",  method: AnalysisMethod.STREAM_SELECTION,
    parameters: { modalities: [Modality.PPG] } },
  { id: "bundle", method: AnalysisMethod.MERGE, parameters: { inputs: 2 } },
]
```

Naming a `stream` on the source node does the same job for a single stream, and
is sugar over the same filter: it is applied to each packet rather than resolved
by a lookup when the receiver attaches, so it is connect-order safe and works on
a relay that names its streams after their source devices rather than after
itself. Reach for `StreamSelection` when you need more than one stream, an
`invert`, or a rule that spans devices.

`StreamSelection` matches on `streams` (a full stream ID exactly, anything else
as a case-insensitive fragment), on `modalities`, or both, and `invert: true`
passes everything that does *not* match. **Packets pass through untouched** —
this is the only node that does not restamp what it forwards, because a router
that renamed the thing it routed would destroy the identity the rest of the
graph addresses it by. It is also the only node that accepts a categorical
stream: routing is not interpretation, so splitting markers off a shared wire
is safe in a way that averaging them is not.

`Merge` concatenates channels in port order across `inputs` ports named `a`,
`b`, `c`, … Channel labels are prefixed with their source stream only where
they would otherwise collide. The merged stream declares a sampling rate only
if every input agrees on one, and a modality only if every input shares it —
both absences are load-bearing, since a merged stream with no rate is correctly
refused by every rate-dependent node downstream rather than being filtered at a
rate that describes none of its channels.

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
packet within `tolerance` ms — appropriate only for sources that share a clock;
`"nearest"` keeps a short history per port and pairs against the packet closest
in time, for transports that buffer by different amounts — a BLE headset
alongside a webcam.

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

### Recording a pipeline

`Recorder` takes any `Observable<DataPacket>`, so it captures pipeline outputs
the same way it captures a device — `getOutput` works on **any** non-sink node,
intermediate or terminal, so you can tap wherever you want:

```ts
const recorder = new Recorder();
recorder.addReceiver(muse);                       // raw device, for replay
recorder.addSource(pipeline.getOutput("bands"));  // + a processed branch
recorder.start();
```

Recording is deliberately **not** a node and not wired into the graph's
execution — it is a side channel you start and stop by hand, and it can just as
well be attached after the fact. What the graph *can* carry is the selection:
an optional, passive `record` block naming the tap points a session captured,
so a stored `{ nodes, edges }` remembers them.

```ts
const pipeline = new Pipeline({
  nodes: [ /* ... */ ],
  edges: [ /* ... */ ],
  record: {
    nodes: ["eeg", "bands"],
    options: { includeTimestamps: true },   // forwarded to the Recorder
  },
});

const recorder = new Recorder(pipeline.recordOptions);
for (const source of pipeline.recordTargets().values()) recorder.addSource(source);
recorder.start();
```

The pipeline never acts on `record`: it builds no `Recorder`, and the named
nodes stay ordinary outputs. `recordTargets()` resolves the ids to observables,
skipping any that no longer name a readable node; `issues()` reports those as
**warnings**, never errors, so a selection stored against an older graph
degrades visibly instead of blocking `validate()`. The shape is intentionally
minimal — a node editor that wants per-tap settings can widen it later without
the runtime needing to care.

## Sending streams elsewhere

`Recorder` writes packets to a file; `StreamTransmitter` sends them to another
context. It takes the same input — any `Observable<DataPacket>`, so a receiver,
a pipeline output, or several at once — plus a **transport**:

```ts
import { StreamTransmitter, WebSocketTransport } from "yq-data";

const out = new StreamTransmitter(new WebSocketTransport("ws://localhost:9000"));
out.addReceiver(muse);
out.addSource(pipeline.getOutput("bands"));
out.start();
```

`RemoteStreamReceiver` is the other end. Give it a transport and the streams
arriving on it register and republish like any local device, so a graph built
against a remote Muse is byte-for-byte the same as one built against a local
one:

```ts
import { RemoteStreamReceiver, WebSocketTransport } from "yq-data";

const remote = new RemoteStreamReceiver(new WebSocketTransport("ws://host:9000"));
await remote.connect();
remote.startStream();

pipeline.attachReceiver("headset", remote);
```

### As pipeline nodes

A transmit or remote-receive endpoint can also be a node in a `Pipeline` graph,
so a stored `{ nodes, edges }` can say "and this branch goes out over a
WebSocket" with no glue code. A `transmit` node is a **sink** — it consumes its
input and ships it out, exposing no output — and a `receive` node is a source
backed by a `RemoteStreamReceiver` the pipeline owns. The transport is a live
object, so like a receiver it is named by key in the JSON and bound at runtime
with `attachTransport()`:

```ts
const pipeline = new Pipeline({
  nodes: [
    { id: "eeg",   receiver: "muse", stream: Modality.EEG },
    { id: "clean", method: AnalysisMethod.FILTERING, parameters: { kind: "bandpass", cutoff: [1, 45] } },
    { id: "bands", method: AnalysisMethod.BAND_POWER },
    { id: "cloud", transmit: { transport: "viz" } },   // sink: bands -> WebSocket
  ],
  edges: [
    { from: ["eeg"],   to: ["clean"] },
    { from: ["clean"], to: ["bands"] },
    { from: ["bands"], to: ["cloud"] },
  ],
});

pipeline.attachReceiver("muse", muse);
pipeline.attachTransport("viz", new WebSocketTransport("ws://visuals:9000"));
pipeline.start();
```

Sinks stay out of `terminalNodes`, `outputs`, `data` and `describe()`; read
`transmitters()` for the outbound side — each sink's transport and a live
per-stream packet count. Because a sink is just another edge target, one
processed stream can fan out to a recorder, a visual and three transports at
once with no special-casing. `MemoryTransport.pair()` wires a `transmit` node to
a `receive` node in the same graph — a round-trip test, or a way to decouple two
halves of a large patch.

### Transports

A `Transport` is a bidirectional channel for values — `send`, `onMessage`,
`close` — and knows nothing about packets.

| Transport | Carries | Notes |
|---|---|---|
| `MemoryTransport` | In-process | `MemoryTransport.pair()` — tests, and wiring a pipeline output back to a source in the same page |
| `PostMessageTransport` | A worker or iframe | Structured clone; a `DataPacket` crosses with its `Float32Array` intact |
| `BroadcastChannelTransport` | Same-origin contexts | Structured clone; one producer fans out to every tab on the channel name |
| `WebSocketTransport` | A server or another machine | The only one that encodes; owns reconnection, same backoff as `LSLReceiver` |

Structured-clone transports need **no codec** — the packet is the message.
`WebSocketTransport` puts every value through a `WireCodec` (JSON by default; a
binary codec is a drop-in replacement) and, because the far end is a different
clock, `RemoteStreamReceiver` files an incoming `timestamp` under `deviceTime`
rather than trusting it as local time. Override with `trustRemoteClock`.

### The wire format

`WebSocketTransport` sends the `yq-data/1` envelope — plain JSON, so a producer
or consumer in another language needs no library:

```jsonc
// announces a stream; sent before its first packet, on change, and on a timer
{ "protocol": "yq-data/1", "type": "meta", "streamID": "muse-1:eeg:raw",
  "metadata": { /* full StreamMetadata */ } }

// one chunk of interleaved samples
{ "protocol": "yq-data/1", "type": "packet", "streamID": "muse-1:eeg:raw",
  "timestamp": 1724716800000, "channelCount": 4, "data": [/* interleaved */],
  "labels": ["go"] }
```

A consumer that only ever sees `packet` messages still reconstructs a usable
stream: the packet names its own `streamID` and `channelCount`, and a
well-formed `deviceID:modality:stage[:name]` ID carries the modality. A later
`meta` upgrades that. Point a different decoder at `RemoteStreamReceiver`
(`{ decode }`) to consume some other protocol — that is all `LSLReceiver`
effectively is over `WebSocketTransport`.

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
