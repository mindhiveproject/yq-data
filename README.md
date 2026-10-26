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
| `ArduinoReceiver` | Arduino, ESP32, other [microcontrollers](#microcontrollers) | Web Serial. The board announces its own streams; also writes to the board |
| `MicrophoneReceiver` | Microphone | AudioWorklet; raw interleaved PCM |
| `VideoReceiver` | Camera | Lifecycle handle only — emits no packets |
| `FaceLandmarkReceiver` | Camera | 52 expression scores (`blendshapes`), head pose; opt-in face box and 478 landmarks |
| `FaceEmotionReceiver` | Camera | 7 facial expression probabilities; opt-in face box and landmarks |
| `PoseReceiver` | Camera | 33 body landmarks |
| `RPPGReceiver` | Camera | Mean skin colour (R, G, B) of forehead and cheeks, for [heart rate](#heart-rate-from-a-camera) |
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
const pulse = new RPPGReceiver(videoElement, { faceSource: face });
```

`faceSource` lets the pulse reuse the face tracker's landmarks instead of
running the same model a second time; without it, `RPPGReceiver` runs its own.

The element must stay mounted while streaming. In a React app, mount it once
outside the panel tree and portal previews into it — unmounting it when a tab
changes kills the camera and every derived stream.

### Heart rate from a camera

Each heartbeat changes the colour of the skin by a fraction of a percent.
`RPPGReceiver` measures that colour: every frame it averages the forehead and
both cheeks, drawn as polygons on the face mesh so they follow the head and
leave out the eyes, brows, nostrils and background. Its stream is three
channels (red, green, blue) at a fixed `samplingRate`. Frames are interpolated
onto that rate, so a camera that slows down in dim light still yields an even
stream.

The rest is a pipeline, and after `pulse` it is the same one a Muse PPG sensor
uses:

```ts
nodes: [
  { id: "rgb",    receiver: "rppg" },
  { id: "pulse",  method: AnalysisMethod.PULSE_EXTRACTION },
  { id: "window", method: AnalysisMethod.WINDOWING,  parameters: { size: 10, hop: 1 } },
  { id: "bpm",    method: AnalysisMethod.HEART_RATE },
]
```

`PulseExtraction` uses POS (Wang et al., 2017) by default. It divides each
channel by its mean over a sliding 1.6 s window, then projects onto the plane
orthogonal to the skin's colour. A change in brightness moves all three
channels together and vanishes in that plane, while the pulse, which is
strongest in green, does not. This is what keeps the rate right when the light
flickers or the head moves. Its output is a `ppg` stream named `pulse`, 1.6 s
behind the camera, with each systole a peak. It matches the paper's algorithm
to float precision, and pyVHR and rPPG-Toolbox too, in the golden suite.

POS has one cost. It mixes three channels, so it carries three channels' sensor
noise. For a still subject in steady light on a noisy camera, especially at
15 fps, `algorithm: "green"` (the green channel alone) has the better
signal-to-noise ratio.

When the face is lost for longer than `maxGap` (0.25 s), the stream goes
silent and restarts when the face returns. Its packets carry a sample clock
(`additionalMetadata.sampleClock`), so `PulseExtraction` and `Windowing` see
the missing time and start again rather than join the two sides. The rate then
returns once a full window has refilled.

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

### Drawing faces

`FaceOverlay` draws face streams onto a canvas laid over the video: the face
box, landmarks (as points, or joined by the model's contours or full mesh), head
pose as three axes, and the leading expression as a label.

```ts
const face = new FaceLandmarkReceiver(video, { emitFaceBox: true, emitLandmarks: true });

const overlay = new FaceOverlay(canvas, { video, layers: { connections: "contours" } });
overlay.attach(face);   // or overlay.push(packet) from a pipeline output
overlay.start();
```

It reads **streams**, not receivers, so the same code draws a local tracker and
one arriving from another machine through a `RemoteStreamReceiver`. The geometry
has to be switched on at the source (`emitFaceBox`, `emitLandmarks`,
`emitHeadPose`); the mesh's edges never travel with the data, because a stream
names its model (`topology`) and the overlay looks the edges up. Points are
normalised to the video frame, and the canvas should cover the video exactly:
the overlay applies the video's `object-fit`. Pass `mirror: true` for a video
flipped with CSS, rather than flipping the canvas too, which would mirror the
label text.

A receiver publishes nothing for a frame with no face. That silence is how a
face leaving the frame reaches the canvas: it is cleared once its streams have
been quiet for `staleAfter` (by default four of the stream's own packet
intervals, the same rule as the pipeline's `maxAge`).

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

### Microcontrollers

`ArduinoReceiver` talks to a board running the yq-data Arduino library over a
serial port. There is nothing to configure on this side: the board announces
its streams — names, modalities, channel layouts, rates, scales — and they
appear as ordinary yq-data streams.

```ts
const transport = await SerialTransport.request({ baudRate: 115200 });
const board = new ArduinoReceiver(transport);
await board.connect();            // opens the port and waits for the board to describe itself
board.startStream();
board.data.subscribe((packet) => ...);
```

`SerialTransport.request()` shows the browser's port picker and needs a click
handler. A port the user has granted before reopens without one through
`SerialTransport.granted()`. Chromium browsers only, like the Muse.

A board can also *receive* — an LED, a motor, a servo. Those streams are its
**sinks**, and you write to them in physical units:

```ts
board.sinks;                      // what the board accepts
board.write("led", 255);
board.write("rgb", [255, 0, 0]);  // interleaved, one value per channel
```

Values are quantised to the sink's format and clamped to its range, and split
across messages if they do not fit one frame.

An `ArduinoReceiver` **claims its transport**: it records on it that the link
speaks [yq-arduino](#protocols), so anything else sending there — a
`StreamTransmitter`, a pipeline `transmit` node — talks to the board in its own
protocol with no options. To feed a sink from a graph, attach the receiver by
hand like a Muse; the graph itself stays plain JSON:

```ts
const pipeline = new Pipeline({
  nodes: [
    { id: "pot", receiver: "board" },
    { id: "norm", method: AnalysisMethod.NORMALIZATION,
      parameters: { mode: "fixed", min: 0, max: 5 } },
    { id: "out", transmit: { transport: "board" } },
  ],
  edges: [{ from: ["pot"], to: ["norm"] }, { from: ["norm"], to: ["out"] }],
});
pipeline.attachReceiver("board", board);
pipeline.attachTransport("board", transport);
```

A packet goes to the sink named like its stream, and anything else is skipped.
To send elsewhere, give the receiver a `route` — a table of stream IDs to sink
names, or a function — as `new ArduinoReceiver(transport, { route })` or later
as `board.protocol.route`. yq-arduino has no metadata message (the board
describes its own streams), so nothing but `data` goes out.

Samples cross the wire as 16-bit (or 8-bit) integers with a scale and offset,
and are converted to `Float32Array` here. The board's own clock arrives as
`deviceTime`, unwrapped across its 32-bit counter. A categorical stream — a
button, say — becomes the same markers `MarkerReceiver` produces.

Opening a serial port resets an Uno and most ESP32 dev boards, so
`connect()` repeats its `hello` until the board is awake (`helloInterval`,
default 500 ms) and gives up after `handshakeTimeout` (default 5 s) with an
error that says what to check.

`SimulatedArduino` is a board in memory: the same protocol, no hardware. It is
what the tests run against, and it works in a demo page too:

```ts
const sim = new SimulatedArduino({
  id: "sim-1",
  streams: [{ name: "pot", format: "uint16", rate: 50, scale: 5 / 1024 }],
});
const board = new ArduinoReceiver(new SerialTransport(sim.port));
await board.connect();
board.startStream();
sim.emit("pot", [2.5]);
```

`ArduinoReceiver` needs the optional `@msgpack/msgpack` peer dependency, loaded
on connect. The protocol is specified in
[docs/arduino-protocol.md](docs/arduino-protocol.md), with shared test vectors in
`protocol/vectors.json` that both this package and the Arduino library are
tested against.

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

When a receiver drops, the nodes downstream of it are reset (`resetOnDisconnect`,
on by default), so a reconnected headset does not inherit a half-full window
from before it was unplugged. Only that receiver's part of the graph is touched:
in a two-headset patch, one person's headset slipping off leaves the other's
windows filling. Where the two meet, only the dropped side's input is cleared,
so pairing resumes as soon as it returns.

A pipeline is a plain object with a small lifecycle: `stop()` stops forwarding
and keeps the graph (`start()` resumes it), `reset()` clears every analyzer's
buffered state, `detachReceiver(key)` unbinds one device, and `destroy()` tears
it down for good. `getMetadata(nodeId)` returns the metadata of a node's latest
output once it has emitted.

A node that throws does not take the stream down. The error is reported and the
packet is dropped; the next one is tried. The same goes for a stream an edge
cannot accept, which is refused once, on its first packet, with the reason, and
dropped from then on while the rest of the graph keeps running. Both go to
`console.error` unless you pass `onError`:

```ts
const pipeline = new Pipeline(graph, {
  onError: (error, nodeId) => reportToMyApp(nodeId, error),
});
```

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
read. Validation is opt-in at start: `start({ validate: true })` throws with the
full list rather than one error per edit-and-rerun cycle, and does not start the
graph.

```ts
pipeline.attachReceiver("markers", markers);
pipeline.start({ validate: true });
// Error: Pipeline graph has 1 compatibility problem:
//   - "power" port "in": stream "markers:event_marker:raw" carries labels ...
```

Because a source can put several streams on one wire, an edge is judged on the
set it carries rather than one stream at a time, and each issue says how much it
costs. Nothing usable is an `"error"` — that node will never emit. Some usable
is a `"warning"`: the graph runs on the rest, which is the ordinary shape of a
fat wire and matches what the runtime does with it. `start({ validate: true })`
throws on errors only; read `issues()` to show warnings.

```ts
pipeline.issues();
//=> [{ nodeId: "power", port: "in", severity: "warning",
//      reason: '1 of 2 streams on this edge will be dropped: stream
//               "psychopy-1:event_marker:raw" carries labels rather than ...' }]
```

#### Before any data flows

The check reaches past the first node. Each analyzer also declares how it
shapes its output — channel labels, name, rate, samples per channel — from the
input's metadata and its own parameters, so the streams leaving a whole chain
of nodes are worked out from the source's with nothing running. That is what
lets a node editor refuse a bad edge, and label an output, with no headset on:

```ts
// eeg -> windowing -> band_power -> connectivity
pipeline.attachReceiver("eeg", muse);
pipeline.issues();
//=> [{ nodeId: "sync", port: "a", severity: "error",
//      reason: 'stream "muse-1:eeg:features:band_power" carries 1 sample per
//               channel in each packet, and this node needs at least 2 — it
//               measures across samples, so it wants a windowed waveform ...' }]

pipeline.describe();
//=> [{ nodeId: "power", streamID: "muse-1:eeg:features:band_power",
//      channels: [{ index: 0, label: "Delta" }, { index: 1, label: "Theta" }, ...] }]
```

The declaration is the same code the node emits through, so what it says ahead
of data and what it sends once data flows cannot drift apart. A node declares
it by implementing `outputOptions(meta)`; one that does not is known only after
it has emitted, and edges downstream of it are not judged until then.

What cannot be known is left unknown rather than guessed. A stream's
`samplesPerChannel` is the packet size where a device or node states it, and an
absent value means "not declared", never "one": `Correlation` and anything else
that sets `accepts.minSamplesPerChannel` refuses only a stream that says it is
too short. Likewise a feature node's rate is its window's packet rate, which
depends on how many samples the device delivers at a time; where that is not
declared the output is marked `unresolved` and rate-dependent nodes downstream
pass on it instead of reading its absence as "irregular".

A source node can declare the streams it expects, for a peer that has not
connected or a headset that is not on:

```ts
{ id: "wire", receive: { transport: "cloud" },
  expects: [{ streamID: "peer:eeg:raw", modality: "eeg", samplingRate: 256,
              channelInfo: [{ index: 0, label: "AF7" }, ...] }] }
```

These stand in until the receiver announces streams of its own, and are replaced
by whatever it announces, so a stale declaration can never override a device.

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
| `FILTERING` | `Filtering` | Butterworth (`scipy.signal.butter`) or windowed-sinc FIR (`firwin`) low/high/band/stop, stateful across packets |
| `NORMALIZATION` | `Normalization` | Min-max, z-score, fixed range, or a decaying running range |
| `CHANNEL_SELECTION` | `ChannelSelection` | Pick or average channels by index or label |
| `FFT` / `PSD` | `SpectrumAnalyzer` | Per-channel spectrum |
| `PULSE_EXTRACTION` | `PulseExtraction` | Camera skin colour to a pulse waveform (POS) |
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

`HeartRate` detects beats with MSPTDfast v2 (Charlton et al., 2025), the
efficient form of MSPTD. MSPTD and qppg were the two best of fifteen
open-source PPG beat detectors benchmarked by Charlton et al. (2022). The port
matches the authors' MATLAB sample for sample. The rate is the median
inter-beat interval in the window. A beat within about half an interval of
the window's edges is not detected, so a 10 s window reports one or two fewer
intervals than it holds, but never a false one. The previous detector, the
adaptive threshold of Shin, Lee & Lee (2009), remains available as
`detector: "adaptive-threshold"`. The node's `spectral` strategy skips detection
entirely and takes the dominant frequency of the pulse band, which is steadier
on camera-derived rPPG but reports no variability. See [References](#references).

`BandPower` reports absolute power by default: a Hamming-windowed PSD
integrated across each band, in µV² for EEG, as YASA, MNE and EEGLAB report
it. For **relative band power**, set `relative: true` and leave the other
defaults alone:

```ts
{ id: "bands", method: AnalysisMethod.BAND_POWER, parameters: { relative: true } }
```

Each band is then its share of the total power across the configured bands,
so the bands sum to 1. This agrees with YASA's `bandpower(relative=True)` to
within 0.04 on the channel average and 0.06 per channel. Three things to keep
in mind:

- **Keep `scaling: "psd"` and `aggregate: "sum"`.** With `"magnitude"` or
  `"mean"`, normalising gives a share of amplitude or of mean density, not of
  power, and alpha reads well below its true share.
- **The total is the sum of the bands you define.** Keep them contiguous and
  non-overlapping, as the defaults are (1–45 Hz), or a gap goes uncounted and
  an overlap is counted twice.
- **Channels.** With `perChannel: true`, each channel is normalised on its own.
  Without it, absolute power is averaged across channels first and the average
  is normalised, so louder channels weigh more.

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

A port that has gone quiet stops contributing instead of pinning the output to
whatever it last sent. `maxAge` sets how old a packet may be, in ms, before its
port reads as stale; `"auto"` (the default) allows four of that port's own packet
intervals, and never less than a second, so a slow stream is not cut off. Age is
measured against the packet that just arrived, not the wall clock, which keeps
the rule meaningful when a recording is replayed off real time.

A multi-input node runs once per upstream packet, after every branch that feeds
it has finished. That matters wherever branches split and rejoin — frontal alpha
asymmetry splits left and right channels off one headset and rejoins them at a
`difference` node — where a node that ran as soon as the first branch arrived
would pair it with the other branch's *previous* packet and then run again, two
outputs per packet, one of them stale. Source nodes reading the same receiver
count as branches of the same split. A branch that did not emit this time (a
window that has not filled) keeps its last value, which is what `"latest"` is for.

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
degrades visibly instead of blocking `start({ validate: true })`. The shape is intentionally
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
| `WebSocketTransport` | A server or another machine | Encodes values through a `WireCodec`; owns reconnection, same backoff as `LSLReceiver` |
| `SerialTransport` | A microcontroller on a serial port | Web Serial. A byte stream, so it frames (COBS and a CRC-16) and encodes MessagePack; no auto-reconnect, since reopening resets the board. See [microcontrollers](#microcontrollers) |

Structured-clone transports need **no codec** — the packet is the message.
`WebSocketTransport` puts every value through a `WireCodec` (JSON by default; a
binary codec is a drop-in replacement) and, because the far end is a different
clock, `RemoteStreamReceiver` files an incoming `timestamp` under `deviceTime`
rather than trusting it as local time. Override with `trustRemoteClock`.

### Protocols

A transport moves values; a **protocol** says what they mean. Each layer is
named on its own axis, so the names never compete:

| Layer | Named after | Examples |
|---|---|---|
| Transport | the mechanism | `WebSocketTransport`, `SerialTransport`, `PostMessageTransport` |
| Codec | the format | `jsonCodec`, `msgpackCodec` |
| Protocol | who is on the other end | `yq-stream` (another yq-data peer), `yq-arduino` (a board) |

Any protocol runs over any transport that suits it — yq-stream over a WebSocket
or a serial cable, yq-arduino over serial, Bluetooth or an ESP32's Wi-Fi. A
transport records the protocol spoken on it as `transport.protocol`;
`StreamTransmitter` and `RemoteStreamReceiver` use that unless given a
`protocol` of their own, and default to yq-stream on a link nothing has claimed.
Versions travel as integers (`v`) and are never part of a protocol's name.

### The stream protocol

yq-stream is what two yq-data peers say to each other. Over a JSON WebSocket it
is plain JSON, so a producer or consumer in another language needs no library:

```jsonc
// announces a stream; sent before its first packet, on change, and on a timer
{ "protocol": "yq-data/1", "type": "meta", "streamID": "muse-1:eeg:raw",
  "metadata": { /* full StreamMetadata */ } }

// one chunk of interleaved samples
{ "protocol": "yq-data/1", "type": "packet", "streamID": "muse-1:eeg:raw",
  "timestamp": 1724716800000, "channelCount": 4, "data": [/* interleaved */],
  "labels": ["go"] }
```

**The tag.** The protocol first shipped with the tag `"yq-data/1"` — name and
version in one string — and other platforms speak it, so that is still what
this package writes. Its name is now yq-stream, and a message may equally be
tagged `{ "protocol": "yq-stream", "v": 1 }`; both are read, and the fields are
identical. To write the new tag, pass
`createStreamProtocol({ emit: "current" })` as the `protocol` of a transmitter.
The default will move once the other platforms accept it. A message of a
different `v` is ignored rather than misread.

A consumer that only ever sees `packet` messages still reconstructs a usable
stream: the packet names its own `streamID` and `channelCount`, and a
well-formed `deviceID:modality:stage[:name]` ID carries the modality. A later
`meta` upgrades that.

To consume some other protocol, give `RemoteStreamReceiver` a `protocol` — an
object with `name`, `version`, `decode(value)` returning stream updates, and
`encodePacket(packet)` returning messages (empty to send nothing). The older
`decode`, `encodePacket` and `encodeMeta` options still work; the exports the
protocol had before the rename (`packetToWire`, `wireDecoder`, …) remain as
deprecated aliases. That is all
`LSLReceiver` effectively is over `WebSocketTransport`, and all
`ArduinoReceiver` is, plus a handshake.

## Working with the DSP directly

Everything under `analyzer/methods` is a pure function over plain arrays, usable
without any packet, receiver or pipeline:

```ts
import { spectrum, bandAverage, butter, sosfiltfilt } from "yq-data";

// Same call, same coefficients as scipy.signal.butter(4, [1, 40], "bandpass", fs=256, output="sos")
const sos = butter(4, [1, 40], { btype: "bandpass", fs: 256, output: "sos" });
const clean = sosfiltfilt(sos, signal);        // scipy.signal.sosfiltfilt
const spec = spectrum(clean, { samplingRate: 256, window: "hamming" });
const alpha = bandAverage(spec, 8, 12);
```

## Performance

Everything runs on the page's main thread, so the question for a session is how
much of one core it takes and whether any single packet takes long enough to
stutter a display. `npm run bench` answers both on the machine it runs on. It
feeds each chain the signal a real device delivers, in the packet sizes it
delivers them, and reports **load**: processing time divided by signal time. 5%
means the chain needs a twentieth of a core to keep up with a live device, and
100% means it falls behind.

Measured on an Apple M4 Pro under Node 26. That is a fast machine, so read the
shape of these numbers rather than the digits, and run the benchmark on the
oldest hardware you expect.

| Chain | Load | Cost per second of signal |
|---|---|---|
| Muse EEG: bandpass → 2 s window → band power | 0.06% | 0.6 ms |
| Muse EEG, per-channel band power, 4 s window | 0.09% | 0.9 ms |
| Muse PPG: 10 s window → heart rate | 0.01% | 0.06 ms |
| Muse PPG: 30 s window, every 0.25 s, with HRV | 0.04% | 0.4 ms |
| Camera: POS → 10 s window → heart rate | 0.01% | 0.1 ms |
| LSL, 32 ch at 1 kHz: bandpass → 2 s window → per-channel band power | 0.7% | 6.8 ms |

Through a whole `Pipeline` the Muse graph costs the same, and its slowest packet
in a minute took about 0.3 ms. Memory is flat over a simulated hour. Building,
`issues()` and `describe()` on a 36-node graph each take under 0.1 ms, so a node
editor can call them on every edit.

What dominates, and what to expect when you change it:

- **The spectrum is the one expensive primitive.** A Hamming-windowed power
  spectrum takes 4 µs at 256 points, 31 µs at 2048 and 134 µs at 8192, and it
  scales with the length of the window times the number of channels, once per
  window emitted. `BandPower` and `SpectrumAnalyzer` pay it; filters, `Windowing`,
  statistics, POS and the beat detector cost microseconds.
- **Output rate is a knob.** A window with `hop: 0.1` emits ten times a second;
  `hop: 0.5` costs a fifth as much and is rarely distinguishable on screen.
- **Windows grow the buffer, not the cost per sample.** A 10 s window of 32
  channels at 1 kHz costs about 0.3 ms to assemble.

Not covered by the benchmark, because it needs a browser and a device:

- **Camera receivers** are dominated by the vision model, which runs
  synchronously on the main thread and so delays everything else on the page
  while it runs. `maxFps` is the cost control (30 by default for MediaPipe, 15
  for `FaceEmotionReceiver`, whose network is heavier). The default `delegate:
  "GPU"` is much faster than `"CPU"` but needs WebGL. Where that is missing,
  `connect()` fails and the receiver must be built with `delegate: "CPU"`.
  `RPPGReceiver` reads pixels from a downscaled crop of the face rather than the
  frame, and shares a `FaceLandmarkReceiver` through `faceSource` instead of
  running the model twice.
- **`FaceOverlay`** redraws on every animation frame. `connections: "mesh"`
  strokes 2556 edges and is much heavier than the default contours.
- **Microphone** audio crosses to the page in 2048-frame packets by transfer, not
  copy; `framesPerPacket` trades latency for message count.

Sending and recording have costs of their own:

- **Over a `WebSocketTransport` (JSON)** a Muse's raw EEG is about 20 KB/s, and
  a windowed 512 × 4 packet is 36 KB. The 478-point `landmarks` stream is 27 KB
  per frame, or about 800 KB/s at 30 fps: send it at a lower `maxFps`, or supply
  a binary `WireCodec`, rather than relying on JSON for it.
- **`Recorder` holds every sample in memory** until you export: 4 bytes a value
  (float32, as the samples arrive) and 8 for each sample's timestamp. That is
  about 21 MB an hour for a Muse and about 470 MB an hour for 32 channels at
  1 kHz. `maxSamplesPerStream` (2 million per stream by default) is counted in
  samples per channel, so it stops a Muse after 2.2 hours but 32 channels at
  1 kHz after 33 minutes, by which time it holds about 270 MB. Lower it for
  dense streams. Export writes the CSV in chunks, so its size is bounded by
  memory rather than by the length of a string, but the archive is built in
  memory too: a 15-minute 32-channel recording peaks at about 2 GB while it
  exports. `FileReplayReceiver` reads each CSV back as one string, so it cannot
  open a single stream much beyond half a gigabyte of CSV.

## References and attribution

Methods:

- Charlton, P.H., Mant, J. & Kyriacou, P.A. (2025). The MSPTDfast
  photoplethysmography beat detection algorithm: design, benchmarking, and
  open-source distribution. *Physiological Measurement*, 46, 035002.
  [doi:10.1088/1361-6579/adb89e](https://doi.org/10.1088/1361-6579/adb89e)
  — the beat detector behind `HEART_RATE`, ported from the MIT-licensed
  [ppg-beats](https://github.com/peterhcharlton/ppg-beats) toolbox.
- Bishop, S.M. & Ercole, A. (2018). Multi-scale peak and trough detection
  optimised for periodic and quasi-periodic neuroscience data. *Acta
  Neurochirurgica Supplement*, 126, 189–195.
  [doi:10.1007/978-3-319-65798-1_39](https://doi.org/10.1007/978-3-319-65798-1_39)
  — MSPTD, which MSPTDfast refines.
- Charlton, P.H. et al. (2022). Detecting beats in the photoplethysmogram:
  benchmarking open-source algorithms. *Physiological Measurement*, 43(8),
  085007. [doi:10.1088/1361-6579/ac826d](https://doi.org/10.1088/1361-6579/ac826d)
  — the benchmark the detector was chosen from.
- Shin, H.S., Lee, C. & Lee, M. (2009). Adaptive threshold method for the peak
  detection of photoplethysmographic waveform. *Computers in Biology and
  Medicine*, 39(12), 1145–1152.
  [doi:10.1016/j.compbiomed.2009.10.006](https://doi.org/10.1016/j.compbiomed.2009.10.006)
  — `HEART_RATE`'s `detector: "adaptive-threshold"`.
- Wang, W., den Brinker, A.C., Stuijk, S. & de Haan, G. (2017). Algorithmic
  principles of remote PPG. *IEEE Transactions on Biomedical Engineering*,
  64(7), 1479–1491.
  [doi:10.1109/TBME.2016.2609282](https://doi.org/10.1109/TBME.2016.2609282)
  — POS, `PULSE_EXTRACTION`'s default algorithm.
- Verkruysse, W., Svaasand, L.O. & Nelson, J.S. (2008). Remote
  plethysmographic imaging using ambient light. *Optics Express*, 16(26),
  21434–21445. [doi:10.1364/OE.16.021434](https://doi.org/10.1364/OE.16.021434)
  — the green channel alone, `PULSE_EXTRACTION`'s `algorithm: "green"`.
- Kim, D.-Y., Lee, K. & Sohn, C.-B. (2021). Assessment of ROI Selection for
  Facial Video-Based rPPG. *Sensors*, 21(23), 7923.
  [doi:10.3390/s21237923](https://doi.org/10.3390/s21237923) — why
  `RPPGReceiver` samples the forehead and the cheeks together.
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
  — the green-channel rPPG approach of the original platform, implemented in
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

Runtime dependencies are `rxjs` and `muse-js`. The DSP in `analyzer/methods` has
none: the FFT behind every spectrum is a radix-2 transform in
`analyzer/methods/fft.ts`.

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
npm test           # jest: unit tests and the golden-value suite
npm run golden     # just the golden-value suite, one line per case
npm run bench      # what a session costs on this machine; see Performance

cd demos && npm install && npm run dev
```

The golden suite holds the DSP to SciPy, YASA, NeuroKit2 and the authors' own
reference code; its [README](tests/unit/golden/README.md) covers how the
reference values are produced and how to add a method. `npm run bench` takes a
section name to run only that part: `dsp`, `chains`, `pipeline` or `io`.

The demo app is the fastest harness for working on a receiver: it aliases
`yq-data` straight to `src/`, so edits appear on save with no rebuild. Its
recording-replay panel needs no hardware at all.
