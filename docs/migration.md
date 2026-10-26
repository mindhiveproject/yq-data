# Migrating from the first networking release

This covers code written against the release that added networking (commit
`47833f4`, "Added networking capabilities") — the one with `yq-data/1`,
`packetToWire` and friends. Protocols were renamed and made into objects, and
the compatibility layer that briefly kept the old names alive has been removed.
Nothing else in the package changed shape.

The naming rule behind it: **transports** are named for the mechanism
(`WebSocketTransport`), **codecs** for the format (`jsonCodec`), **protocols**
for who is on the other end (`yq-stream`, `yq-arduino`, `lsl`). A version is a
number on the wire (`v`), never part of a name. See the README's
[Protocols](../README.md#protocols).

## 1. The wire message — the one that can fail silently

Every JSON message changes its tag, and gains `v`:

```diff
- { "protocol": "yq-data/1", "type": "packet", "streamID": "muse-1:eeg:raw", ... }
+ { "protocol": "yq-stream", "v": 1, "type": "packet", "streamID": "muse-1:eeg:raw", ... }
```

`meta` messages change the same way. Nothing else in either message moved.

**A message tagged `yq-data/1` is ignored, without an error.** A producer that
has not been updated looks exactly like a producer with nothing to say. If
streams stop appearing after an upgrade, check the tag first.

### Producers and consumers in other languages

Change the constant, and add the field. In Python:

```diff
- msg = {"protocol": "yq-data/1", "type": "packet", ...}
+ msg = {"protocol": "yq-stream", "v": 1, "type": "packet", ...}
```

and on the consuming side:

```diff
- if msg.get("protocol") == "yq-data/1":
+ if msg.get("protocol") == "yq-stream" and msg.get("v") == 1:
```

### Order of upgrade

There is no overlap to lean on: a new yq-data peer cannot read the old tag, and
an old one cannot read the new. **Upgrade both ends of a link together**, and
keep the other links on the old package until they can follow. A non-yq-data
peer you control can accept both tags in the meantime:

```python
if msg.get("protocol") == "yq-data/1" or (
    msg.get("protocol") == "yq-stream" and msg.get("v") == 1
):
```

## 2. Renamed exports

The old names are gone. The new ones do the same job.

| Before | After |
|---|---|
| `WIRE_PROTOCOL` (`"yq-data/1"`) | `STREAM_PROTOCOL` (`"yq-stream"`) and `STREAM_PROTOCOL_VERSION` (`1`) |
| `packetToWire(packet)` | `encodeStreamPacket(packet)` |
| `metaToWire(metadata)` | `encodeStreamMeta(metadata)` |
| `isWireMessage(value)` | `isStreamMessage(value)` |
| `wireDecoder()` | `streamProtocol.decode`, or `decodeStreamMessage` |
| `WireMessage`, `WireMetaMessage`, `WirePacketMessage` | `StreamMessage`, `StreamMetaMessage`, `StreamPacketMessage` |
| `TransportDecoder` | `Protocol["decode"]` |

`WireCodec` and `jsonCodec` keep their names: "wire" now only means the bytes on
the link, which is what a codec makes.

## 3. Options that took functions now take a protocol

A protocol is one object that both reads and writes a link's messages. It
replaces the three loose functions.

**`RemoteStreamReceiver` — `decode` becomes `protocol`:**

```diff
- new RemoteStreamReceiver(transport, { decode: (value) => myDecode(value) });
+ new RemoteStreamReceiver(transport, {
+   protocol: {
+     name: "mine",
+     version: 1,
+     decode: (value) => myDecode(value),
+     encodePacket: () => [],        // nothing is sent back
+   },
+ });
```

**`StreamTransmitter` — `encodePacket` and `encodeMeta` become `protocol`:**

```diff
- new StreamTransmitter(transport, {
-   encodePacket: (packet) => (wanted(packet) ? toMessage(packet) : undefined),
-   encodeMeta: (metadata) => toMeta(metadata),
- });
+ new StreamTransmitter(transport, {
+   protocol: {
+     name: "mine",
+     version: 1,
+     decode: () => [],
+     encodePacket: (packet) => (wanted(packet) ? [toMessage(packet)] : []),
+     encodeMeta: (metadata) => toMeta(metadata),
+   },
+ });
```

Two differences to know about: `encodePacket` returns an **array** of messages
(so one packet can become several, e.g. split to fit a small frame), and an
**empty array** skips the packet — `undefined` is no longer the signal. A
protocol with no `encodeMeta` never announces metadata.

If a transport only ever speaks one protocol, set it once on the transport
instead of on every transmitter and receiver:

```ts
transport.protocol = myProtocol;   // StreamTransmitter and RemoteStreamReceiver read it
```

Without either, a link speaks `yq-stream`.

## 4. `LSLReceiver`

Its public use is unchanged — `new LSLReceiver(options)`, `connect(url)`,
`startStream()`, `discoveredStreams`, the reconnect options, the streams and
metadata it produces. Underneath, it is now a `RemoteStreamReceiver` reading the
new `lsl` protocol (`LSLProtocol`) over a `WebSocketTransport`.

What differs:

- **`connect(url)` that fails now closes the transport.** Before, a failed first
  connect rejected but the receiver kept retrying in the background; now
  nothing is left running, so call `connect()` again to retry. (The address is
  remembered: `connect()` with no argument reuses it.)
- **`LSLReceiver` is a `RemoteStreamReceiver`**, so it has its `protocol`
  (`receiver.protocol.streamKeys`, `.reset()`), and `disconnect()` closes the
  link it made. It can `connect()` again afterwards.
- **A new option, `transport`**, builds the link for an address instead of a
  `WebSocketTransport`.
- **Unparseable messages** are logged by the transport
  (`"WebSocketTransport: dropping an undecodable message."`) rather than by the
  receiver.

The protocol can now be used anywhere a transport can, which the receiver
could not:

```ts
// As a pipeline source, with a graph that stays plain JSON:
transport.protocol = new LSLProtocol();
// { id: "eeg", receive: { transport: "relay" }, stream: "eeg" }
```

## 5. Where `RemoteStreamReceiver` changed shape

It now also accepts a **factory** in place of a transport —
`new RemoteStreamReceiver(() => makeTransport())` — which is called on each
`connect()`, so the receiver can connect again after a `disconnect()` and does
not need the address up front. A transport you hand it directly behaves exactly
as before.

## Checklist

1. Search your code for `yq-data/1`, `packetToWire`, `metaToWire`, `isWireMessage`,
   `wireDecoder`, `WIRE_PROTOCOL`, `TransportDecoder`, `Wire*Message`.
2. Search for `RemoteStreamReceiver(` and `StreamTransmitter(` calls that pass
   `decode`, `encodePacket` or `encodeMeta`.
3. Update every producer and consumer outside this package that speaks the
   JSON messages (§1).
4. Run your graphs once and confirm every stream you expect is announced — the
   unmigrated-tag failure is silent.
