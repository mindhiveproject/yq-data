# Sending streams: transports and protocols

`Recorder` writes packets to a file; `StreamTransmitter` sends them to another
context. It takes the same input — any `Observable<DataPacket>`, so a receiver,
a pipeline output, or several at once — plus a **transport**:

```ts
import { StreamTransmitter, WebSocketTransport } from "@mindhive_science/yq-data";

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
import { RemoteStreamReceiver, WebSocketTransport } from "@mindhive_science/yq-data";

const remote = new RemoteStreamReceiver(new WebSocketTransport("ws://host:9000"));
await remote.connect();
remote.startStream();

pipeline.attachReceiver("headset", remote);
```

## As pipeline nodes

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

## Transports

A `Transport` is a bidirectional channel for values — `send`, `onMessage`,
`close` — and knows nothing about packets.

| Transport | Carries | Notes |
|---|---|---|
| `MemoryTransport` | In-process | `MemoryTransport.pair()` — tests, and wiring a pipeline output back to a source in the same page |
| `PostMessageTransport` | A worker or iframe | Structured clone; a `DataPacket` crosses with its `Float32Array` intact |
| `BroadcastChannelTransport` | Same-origin contexts | Structured clone; one producer fans out to every tab on the channel name |
| `WebSocketTransport` | A server or another machine | Encodes values through a `WireCodec`; owns reconnection, which `LSLReceiver` uses |
| `SerialTransport` | A microcontroller on a serial port | Web Serial. A byte stream, so it frames (COBS and a CRC-16) and encodes MessagePack; no auto-reconnect, since reopening resets the board. See [microcontrollers](microcontrollers.md) |
| `BluetoothTransport` | A device on a Bluetooth Low Energy UART | Web Bluetooth. Framed like `SerialTransport` by default; a device with its own format passes `framing` and `codec`. Nordic UART by default, other UUIDs configurable; no auto-reconnect. See [microcontrollers](microcontrollers.md) |

Structured-clone transports need **no codec** — the packet is the message.
`WebSocketTransport` puts every value through a `WireCodec` (JSON by default; a
binary codec is a drop-in replacement) and, because the far end is a different
clock, `RemoteStreamReceiver` files an incoming `timestamp` under `deviceTime`
rather than trusting it as local time. Override with `trustRemoteClock`.

## Protocols

A transport moves values; a **protocol** says what they mean. Each layer is
named on its own axis, so the names never compete:

| Layer | Named after | Examples |
|---|---|---|
| Transport | the mechanism | `WebSocketTransport`, `SerialTransport`, `BluetoothTransport`, `PostMessageTransport` |
| Codec | the format | `jsonCodec`, `msgpackCodec`, `textCodec` |
| Protocol | who is on the other end | `yq-stream` (another yq-data peer), `yq-arduino` (a board), `lsl` (an LSL relay) |

Any protocol runs over any transport that suits it — yq-stream over a WebSocket
or a serial cable, yq-arduino over serial, Bluetooth or an ESP32's Wi-Fi. A
transport records the protocol spoken on it as `transport.protocol`;
`StreamTransmitter` and `RemoteStreamReceiver` use that unless given a
`protocol` of their own, and default to yq-stream on a link nothing has claimed.
Versions travel as integers (`v`) and are never part of a protocol's name.

A protocol is one object — `name`, `version`, `decode(value)` returning stream
updates, `encodePacket(packet)` returning the messages that carry it (empty to
send nothing), and optionally `encodeMeta(metadata)`. A protocol with no
`encodeMeta` has no metadata message, and a transmitter speaking it never
announces. Two of the three are translation layers onto this package's own
streams: `lsl` is decode-only, and `yq-arduino` quantises on the way out.

## The stream protocol

yq-stream is what two yq-data peers say to each other. Over a JSON WebSocket it
is plain JSON, so a producer or consumer in another language needs no library:

```jsonc
// announces a stream; sent before its first packet, on change, and on a timer
{ "protocol": "yq-stream", "v": 1, "type": "meta", "streamID": "muse-1:eeg:raw",
  "metadata": { /* full StreamMetadata */ } }

// one chunk of interleaved samples
{ "protocol": "yq-stream", "v": 1, "type": "packet", "streamID": "muse-1:eeg:raw",
  "timestamp": 1724716800000, "channelCount": 4, "data": [/* interleaved */],
  "labels": ["go"] }
```

A message of a different `v` is ignored rather than misread — and so is one
tagged `"yq-data/1"`, the name this protocol first shipped under.

A consumer that only ever sees `packet` messages still reconstructs a usable
stream: the packet names its own `streamID` and `channelCount`, and a
well-formed `deviceID:modality:stage[:name]` ID carries the modality. A later
`meta` upgrades that.

To speak some other protocol, give `RemoteStreamReceiver` or `StreamTransmitter`
a `protocol`, or set `transport.protocol` once for the whole link. `LSLReceiver`
is a `RemoteStreamReceiver` reading the `lsl` protocol over a
`WebSocketTransport`, and `ArduinoReceiver` is one reading `yq-arduino`, plus a
handshake.
