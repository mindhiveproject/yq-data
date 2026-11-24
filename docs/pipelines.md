# Pipelines

A `Pipeline` runs a graph of analyzers over connected receivers. The graph is
plain JSON, so a processing chain can be stored in a database and rehydrated
without any code:

```ts
import { Pipeline, AnalysisMethod, Modality } from "@mindhive_science/yq-data";

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

## Outputs

What leaves a graph — what a visual binds to, a `Recorder` captures or a
transmitter sends — is its **outputs**. By default every terminal node is one,
whole. A graph can name them instead, down to one stream of a node that carries
several:

```ts
const pipeline = new Pipeline({
  nodes: [{ id: "camera", receiver: "face" }],
  edges: [],
  // The tracker also emits the face box and landmarks a preview draws;
  // only these two leave the graph.
  outputs: [
    { node: "camera", stream: "blendshapes" },
    { node: "camera", stream: "head_pose" },
  ],
});

pipeline.outputs;     // Map<nodeId, Observable<DataPacket>>, only the named streams
pipeline.data;        // all of them merged
pipeline.describe();  // one entry per output stream, before any data flows
```

`stream` matches a packet's `metadata.name`. An output may be any node,
terminal or not, but not a `transmit` sink; naming one that does not exist is
rejected at construction, like an edge would be.

## Receivers in the graph

A graph can say which device each source key stands for, in
`graph.receivers`, and the pipeline builds those receivers itself with
`createReceiver()`. The graph then describes its sources completely, so
`describe()` reports every output with nothing connected, and an app needs
no separate list of what a block produces:

```ts
const pipeline = new Pipeline(
  {
    nodes: [{ id: "face", receiver: "camera" }],
    edges: [],
    receivers: { camera: { device: "face_landmark", options: { numFaces: 2 } } },
  },
  // What JSON cannot hold, by receiver key, laid over the stored options.
  { receiverOptions: { camera: { videoElement } } }
);

pipeline.describe();                     // the face streams, before any camera is on
await pipeline.getReceiver("camera").connect(); // from a click
```

The pipeline builds the receivers but does not connect them, because most
devices can only be opened from a user gesture. `attachReceiver(key, …)`
still works, and replaces a receiver built from the graph. A built receiver
is disconnected on `destroy()`.

## Parameters

A graph can expose some of its nodes' parameters, so each study or visual
using it can choose its own value without a copy of the graph. A node reads
one with `{ "$parameter": "<name>" }` in place of a value:

```ts
const graph = {
  nodes: [
    { id: "eeg",    receiver: "muse", stream: Modality.EEG },
    { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: { $parameter: "window" } } },
    { id: "bands",  method: AnalysisMethod.BAND_POWER },
  ],
  edges: [
    { from: ["eeg"],    to: ["window"] },
    { from: ["window"], to: ["bands"]  },
  ],
  parameters: { window: { label: "Window length", default: 4, min: 1, max: 10 } },
};

graphParameters(graph);
// { window: { type: "number", unit: …, label: "Window length", default: 4, min: 1, max: 10 } }

const pipeline = new Pipeline(graph, { parameters: { window: 2 } });
pipeline.setParameter("window", 6);
```

A receiver's options can read parameters the same way, so connection
settings and processing settings are one list:
`receivers: { camera: { device: "face_landmark", options: { numFaces: { $parameter: "faces" } } } }`.

An entry in `graph.parameters` needs only what differs from the method's or
receiver's schema: type, default and range come from what reads it, and a
`min` or `max` given here narrows the range for this graph. `graphParameters()`
works them out with no pipeline running, which is what a settings panel needs.
A value is checked against the graph's entry and against every node that reads
it; one out of range throws. Values for names the graph does not declare are
ignored, so values saved against an older version of a graph still load.

`setParameter()` rebuilds each node that reads the parameter and restarts it
and everything downstream from empty, as a disconnect does. A receiver built
from `graph.receivers` is rebuilt too, which means reopening the device: a
connected one is disconnected, and the new one connected and started, with
any failure sent to `onError`. A device that has to ask for a port (an
Arduino link) can only do that from a click, so connect it from one. `undefined` puts
the default back, and `pipeline.parameters` holds the current values.
`describe()` follows the change at once, so re-read it when a parameter
changes what a node outputs, such as its bands or channels.

## Compatibility

Every analyzer declares what it will accept as data, not as a predicate:

```ts
readonly accepts: Accepts = { requiresSamplingRate: true };
```

That declaration is checked against `StreamMetadata`, which a receiver
publishes when it registers a stream — before any packet arrives. So the
question a node editor needs answered ("may I draw this edge?") can be answered
while the user is still dragging it:

```ts
import { canConnect, compatibleMethods, registeredMethods } from "@mindhive_science/yq-data";

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

### Before any data flows

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

Most of the time you do not need `expects`. A receiver that works out its
streams from its own options says so before it connects
(`receiver.expectedStreams()`): `MuseReceiver`, `FaceLandmarkReceiver`,
`FaceEmotionReceiver`, `PoseReceiver` and `RPPGReceiver` do, so a graph built
over any of them describes itself as soon as the receiver is attached, with no
headset on and no model loaded. A Muse's PPG is laid out as a Muse 2's until it
connects and reports its model, unless it was told to expect an
[Athena](receivers.md#muse-s-athena). Receivers that only learn their streams from
the hardware or a peer (Emotiv, LSL, Arduino, audio) stay unknown until they
connect, and are where `expects` earns its place. A link receiver can also be
told what device is on the other end
([`expects: "muse"`](receivers.md#creating-receivers-by-name)).

`describe()` is worked out on each call. Once a source has announced its
streams, it is described as it really is, `expects` or not, including streams
nobody expected; each receiver's `streams$` emits when that changes.

When an output is unknown, `describe()` says why in `reason`: no receiver
attached for a key, a receiver that has not announced anything, or a node
upstream that declares nothing ahead of data.

## Windowing is explicit

Devices deliver signal in whatever chunk their transport dictates — Muse sends
12 EEG samples at a time — while spectral analysis needs a window of a second or
more. `Windowing` is a node in the graph rather than hidden inside each
analyzer, which keeps every downstream analyzer stateless and makes the window
length a visible property of the pipeline. Anything spectral needs one upstream.

## Routing: splitting and joining wires

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

## Multi-input nodes

`Correlation`, `MathNode` and `Merge` extend `MultiInputAnalyzer`, which takes
several named ports. Edges route to a port by name:

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
`math` node — where a node that ran as soon as the first branch arrived
would pair it with the other branch's *previous* packet and then run again, two
outputs per packet, one of them stale. Source nodes reading the same receiver
count as branches of the same split. A branch that did not emit this time (a
window that has not filled) keeps its last value, which is what `"latest"` is for.
