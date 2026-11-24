# Receivers

The [README](../README.md#receivers) lists every receiver. This page covers how to use the ones that need more than `connect()`.

## Common interface

Every receiver exposes `connect`, `startStream`, `stopStream`, `disconnect`, an `isConnected$` observable, a merged `data` observable, and `getData(stream)` for one specific stream.

## Creating receivers by name

An application that stores *which* device to connect, rather than code, can
build receivers by type name. `createReceiver` takes one options object: the
receiver's own options, plus `videoElement` for a camera receiver.
`registerReceiver(type, factory)` adds your own, and `registeredReceivers()`
lists them.

```ts
import { createReceiver } from "@mindhive_science/yq-data";

const muse = createReceiver("muse");
const face = createReceiver("face_landmark", { videoElement, maxFps: 15 });
```

Receivers that read a link take plain options saying how to open it, so they
can be stored as JSON too, and all connect with no arguments:

```ts
createReceiver("lsl", { address: "ws://localhost:8080" });
createReceiver("remote", { url: "ws://lab-pc:9000" });
createReceiver("arduino", { link: "serial", linkOptions: { baudRate: 115200 } });
createReceiver("arduino", { link: "bluetooth" });
```

An Arduino's port or device is asked for when `connect()` is called, so call it
from a click. A live `transport` still works in place of any of these.

These three learn their streams from the other end, so they cannot describe
themselves before connecting. When you know what is on the other end, say so
with `expects` — metadata, or the name of the receiver that would produce it:

```ts
// A relay forwarding a Muse describes itself as one until it announces.
createReceiver("remote", { url, expects: "muse" });
```

Whatever the other end announces replaces it, and `streams$` emits on each
new stream or metadata change, so read `pipeline.describe()` again then.

The built-in types are `muse`, `emotiv`, `microphone`, `voice_emotion`,
`video`, `face_landmark`, `face_emotion`, `pose`, `rppg`, `lsl`, `marker`,
`file_replay`, `arduino` and `remote`. `receiverSchema(type)` lists the options
each one takes, with the type, default and range of each, in the same form as
an analyzer's `parameterSchema()`. It leaves out what only the app can give: a
`videoElement`, EMOTIV's client credentials, a live `transport`.

A graph can also name its receivers itself, in `graph.receivers`, and the
pipeline builds them; see [Pipelines](pipelines.md#receivers-in-the-graph).

## Event markers

`MarkerReceiver` is a stream of timed events pushed in by whatever code runs alongside the pipeline. It can be helpful for experiment or other data types to push data into pipelines and have it be recorded alongside your physio data sources.

```ts
import { MarkerReceiver } from "@mindhive_science/yq-data";

const markers = new MarkerReceiver();
markers.connect();

// in a jsPsych trial, for example:
on_start: () => markers.mark("stimulus_onset", { timestamp: Date.now() }),
```

Pass `timestamp` captured at the event itself wherever you can. `mark()` will stamp the moment it is called, but that is already after whatever ran between the event and the call.

Each marker is one sample: the string in `labels`, and a numeric code in `data` assigned per unique label. `Recorder` writes markers as their own CSV with a `label` column to make epoching or analysis easier later on.

## Muse S Athena

The 2025 Muse S (model MS-03, USB-C) sends every sensor on one Bluetooth
characteristic in a format of its own. `MuseReceiver` finds out which generation
it has on connecting, so nothing has to know in advance:

```ts
const muse = new MuseReceiver();                       // whichever is picked
const muse = new MuseReceiver({ preset: "p1035" });    // if it is an Athena, send this
const muse = new MuseReceiver({ model: "athena" });    // expect an Athena
```

`model` is optional, and does two things. `expectedStreams()` and `describe()`
then give the exact layout before connecting, where an undecided receiver previews
a Muse 2's. And a headband that is plainly the other generation is refused, where
an undecided receiver takes either.

The preset decides what an Athena sends, and it never confirms one. A reading
that does not fit the preset is dropped, with one warning.

| Preset | EEG channels | Optical channels |
|---|---|---|
| `p21` | 4 | none |
| `p1035` | 4 | 4 |
| `p1034` | 4 | 8 |
| `p1045`, `p1046`, `p4129` | 8 | 4 |
| `p1044` | 8 | 8 |
| `p1041` (default), `p1042` | 8 | 16 |

The EEG stream is `TP9`, `AF7`, `AF8`, `TP10` under every preset. Pass
`enableAUX: true` to add `AUX1`–`AUX4` on the presets that send them.

Optical channels arrive on the `ppg` stream, labelled by side, detector and light:
`LI_RED` is left inner, red. `730` and `850` are the LEDs in nm, and `AMB` is
ambient light. One graph serves every generation, because `ChannelSelection` skips
a label the stream does not have:

```ts
nodes: [
  { id: "ppg",    receiver: "muse", stream: Modality.PPG },
  { id: "pulse",  method: AnalysisMethod.CHANNEL_SELECTION, parameters: { labels: ["infrared", "LI_RED"] } },
  { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 10, hop: 1 } },
  { id: "bpm",    method: AnalysisMethod.HEART_RATE },
]
```

Only `p1041` and `p1042` send red and ambient channels, so this graph finds no
pulse channel on an Athena under any other preset. A heart rate has been checked
against a recording under `p1041` only, so test another preset before relying on
it. An Athena's timestamps come from the host, not the headband's clock.

## Lab Streaming Layer

LSL is a native protocol with no browser binding, so `LSLReceiver` does not
talk to LSL directly — it connects to a relay running on the machine the
streams are on, which forwards them as JSON over a WebSocket:

```ts
const lsl = new LSLReceiver({ address: "ws://localhost:8080" });
await lsl.connect();
```

[LSLWebsocketMirror](https://github.com/esromerog/LSLWebsocketMirror) is a
Python script that does this. Any relay emitting the same message shape works
— `{ "<streamKey>": { info, timeseries, timestamp } }`, `info` on the first
message for a stream — so an existing bridge can be pointed at this instead.

What the relay says is read by the `lsl` [protocol](transports-and-protocols.md#protocols) (`LSLProtocol`),
which `LSLReceiver` speaks over a `WebSocketTransport`. Because it is a protocol
rather than a socket, it works anywhere a transport does — including as a
pipeline source whose graph stays plain JSON:

```ts
transport.protocol = new LSLProtocol();
// { id: "eeg", receive: { transport: "relay" }, stream: "eeg" }
```

It is decode-only: yq-data sends nothing back to LSL.

One relay commonly carries several devices; each LSL stream becomes its own
yq-data stream, keyed by `source_id`. Use `StreamSelection` to pull individual
streams off that shared wire — see [routing](pipelines.md#routing-splitting-and-joining-wires).

An LSL stream of type `Markers` becomes exactly the same shape a
`MarkerReceiver` produces: `valueType: "categorical"`, no sampling rate, one
label per sample with a numeric code assigned per distinct label. LSL marker
outlets declare a string channel format, which is the one format ordinary
streams reject, so markers are the deliberate exception to that rule. An
experiment marking trials from PsychoPy over LSL is indistinguishable
downstream from one calling `mark()` in the page.

## Emotion

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

`VoiceEmotionReceiver` runs the classifier itself rather than through
TensorFlow.js — it is a 30k-parameter dense stack, and `ML5Classifier` reads
ml5's saved format and does the forward pass directly, verified against
TensorFlow.js in `tests/unit/ml5_model.test.ts`.
