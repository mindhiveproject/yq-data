# `yq-arduino` — the board protocol

Status: **the app side is built for serial** (phases 1–3 in §8); the Arduino
library and Bluetooth are not. This is the contract between yq-data (browser)
and an Arduino-class board (AVR, ESP32), over Web Serial or Web Bluetooth. The
wire format is normative and pinned by `protocol/vectors.json`; the C++ API
section is a plan. This is version 1, carried on the wire as `v`.

yq-data has two protocols of its own, named after who is on the other end:
**yq-stream** between two yq-data peers (see
[the stream protocol](../README.md#the-stream-protocol)), and **yq-arduino**
with a board. They are separate because they assume different machines:
yq-stream carries full stream metadata and float samples as JSON-friendly
values; yq-arduino assumes 2 KB of RAM. Protocols are independent of
transports — yq-arduino runs over serial, Bluetooth, or an ESP32's Wi-Fi alike.

## 1. Goals and non-goals

- A board can **send** streams to the app (sensors) and **receive** streams from
  it (LEDs, motors, a pipeline's output). Same protocol, both directions.
- Every sample is **16-bit or smaller** on the wire. The app converts to
  `Float32Array` on arrival.
- One protocol over **Web Serial and Web Bluetooth**. The firmware sees both as
  an Arduino `Stream`.
- Built from **existing standards** (MessagePack, COBS, CRC-16) so neither side
  hand-rolls a parser.
- Non-goals for v1: float samples, time sync beyond ping/pong, firmware
  update, board-to-board.

Browser support is Chromium only (Web Serial, Web Bluetooth), same constraint as
`MuseReceiver`.

## 2. Layers

```
 ┌───────────────────────────────────────────────┐
 │ 4  Messages     MessagePack arrays            │  [type, ...]
 │ 3  Integrity    CRC-16/CCITT-FALSE, appended  │  body ‖ crc_lo ‖ crc_hi
 │ 2  Framing      COBS, 0x00 delimiter          │  cobs(body ‖ crc) ‖ 00
 │ 1  Byte pipe    Web Serial │ BLE UART service │  a stream of bytes
 └───────────────────────────────────────────────┘
```

Both pipes are treated as **byte streams**. A BLE notification is just a chunk
of bytes; a frame may span several, or several frames may share one. That is
what makes the MTU a latency detail instead of a correctness one, and it is why
the Arduino library can sit on `Stream&` and not care which pipe it has.

### 2.1 Framing — COBS

Each frame is `COBS(body ‖ crc16)` followed by a single `0x00` byte. COBS
guarantees `0x00` never appears inside a frame, so a receiver that loses its
place resynchronises at the next `0x00`.

- A receiver accumulates bytes until `0x00`, then decodes the accumulated frame.
  Zero-length frames are ignored.
- **Either side sends a lone `0x00` first** after opening a pipe, to flush
  whatever half-frame the other side may be holding.
- Maximum `body ‖ crc` length is **254 bytes**, so COBS adds exactly one byte.
  Maximum encoded frame including delimiter: **256 bytes**.
- **COBS detail that matters at the limit:** when the input ends exactly on a
  full 254-byte block (code `0xFF`), the encoder emits **no** empty block after
  it. A naive encoder appends a trailing `01` there and turns 254 bytes into 256,
  which overflows the bound above. A decoder must accept both forms, and a
  code of `0xFF` means 254 data bytes with **no** implied zero after them.
  `protocol/vectors.json` has the cases.
- A board may advertise a smaller limit (`mf`, §3.1) when its receive buffer is
  small. The app must not send frames larger than it.

### 2.2 Integrity — CRC-16/CCITT-FALSE

Polynomial `0x1021`, init `0xFFFF`, no reflection, no final XOR. Check value:
`crc16("123456789") = 0x29B1`. Computed over the MessagePack body only, appended
**low byte first**. A frame whose CRC fails, whose COBS is malformed, or whose
body does not decode is dropped silently (and counted, for diagnostics).

### 2.3 Messages — MessagePack

The body is exactly one MessagePack value, an array whose first element is the
message type. **Multi-byte integers inside MessagePack follow the MessagePack
spec (big-endian).** The only little-endian data is the raw sample bytes inside
a `bin` (§3.3) and the CRC.

- Unknown message types are ignored.
- Unknown keys in a map are ignored. This is the extension mechanism within v1.
- A breaking change bumps `v`. The protocol's name never changes.

The board only ever needs a small subset of MessagePack: fixarray, fixmap,
fixstr/str8, positive fixint, uint8/16/32, float32, bin8. Anything an
off-the-shelf encoder produces for these is valid, so the firmware may use a
MessagePack library or write them by hand (§7).

## 3. Messages

| Type | Name | Direction | Body |
|---|---|---|---|
| 1 | `board` | board → app | `[1, {v, id, tu, mf, ns, name?, fw?}]` |
| 2 | `stream` | board → app | `[2, {i, n, m, d?, c?, r?, f?, k?, o?, l?, u?, q?}]` |
| 3 | `data` | both | `[3, idx, t, bin]` |
| 4 | `hello` | app → board | `[4, v]` |
| 5 | `start` | app → board | `[5]` |
| 6 | `stop` | app → board | `[6]` |
| 7 | `ping` | app → board | `[7, seq]` |
| 8 | `pong` | board → app | `[8, seq, t]` |

### 3.1 `board`

| Key | Type | Meaning |
|---|---|---|
| `v` | uint | Protocol version the board speaks. `1`. |
| `id` | str | Stable board id. Becomes `deviceID` in stream IDs, so **no `:`**. |
| `tu` | str | Time unit of every `t` from this board: `"ms"` or `"us"`. |
| `mf` | uint | Largest frame the board can *receive*, measured **after COBS decoding** and including the CRC: `len(body) + 2` (≤ 254, ≥ 64). Default 254. The board's raw receive buffer therefore needs `mf + 1` bytes (the COBS byte), plus the delimiter if it stores it. |
| `ns` | uint | Number of `stream` messages that follow. |
| `name`, `fw` | str | Optional human name and firmware version. |

### 3.2 `stream`

Sent once per stream, right after `board`, in index order. One message per
stream so each fits in a 64-byte frame.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `i` | uint | — | Stream index, unique on this board (0–255). What `data` refers to. |
| `n` | str | — | Stream name, **no `:`**. |
| `m` | str | `"unknown"` | A yq-data `Modality` value (`"eeg"`, `"accelerometer"`, `"event_marker"`, …). Unrecognised strings become `unknown`. |
| `d` | uint | `0` | Direction. `0` = board → app (a source). `1` = app → board (a sink). |
| `c` | uint | `1` | Channels. Samples are interleaved: sample `s` of channel `ch` is at `s*c + ch`. |
| `r` | uint | absent | Sampling rate in Hz. **Absent or `0` means irregular**: one sample per `data` message, timestamped by `t`. |
| `f` | uint | `0` | Sample format: `0` int16, `1` uint16, `2` int8, `3` uint8. Little-endian. |
| `k` | float | `1` | Scale. |
| `o` | float | `0` | Offset. Physical value = `raw * k + o`. |
| `l` | [str] | — | Channel labels. Omit if they would not fit in `mf`. |
| `u` | str | — | Unit for all channels (`"µV"`, `"g"`, `"°C"`). |
| `q` | [str] | — | **Categorical stream**: raw values are indexes into this table. See below. |

Why integer + scale rather than float16: AVR has no half-float, and an ADC
reading is already an integer. `k` and `o` carry the calibration (`3.3/1023` for
a 10-bit pin, say), and the app does the multiply. Send `k`/`o` as float32.

A categorical stream (`q` present) maps onto the package's categorical markers:
the app emits `valueType: "categorical"`, no sampling rate, `labels[i] = q[raw]`,
and numeric codes `raw + 1` to match `MarkerReceiver` and `LSLReceiver`, whose
codes start at 1. A button is `q: ["released", "pressed"]`.

### 3.3 `data`

`[3, idx, t, payload]`

- `idx`: stream index, from a `stream` message. Direction is whatever that
  stream declared.
- `t`: uint32, timestamp of the **first sample** in the payload, in the board's
  `tu`. It rolls over (49 days at ms, 71 minutes at µs); the receiver unwraps it
  (§5). Sample `s` is at `t + s / r`.
- `payload`: MessagePack `bin` of `count * c * sizeof(f)` bytes, little-endian,
  interleaved. `count` is implied by the length. Irregular streams (`r` absent)
  carry exactly one sample.

A `data` message for an unknown `idx` is ignored. For app → board streams the
app sends its own clock (ms, mod 2³²) in `t`; a sink may ignore it.

Overhead for a regular stream: 1 (array) + 1 (type) + 1 (idx) + 5 (`t`) +
2 (`bin` header) = 10 bytes, plus 2 CRC, 1 COBS, 1 delimiter = **14 bytes per
frame**. The maximum payload is 240 bytes, which is 120 int16 samples.

Worked numbers: 8 channels at 250 Hz as int16 is 4 kB/s. In 8-sample chunks
(128 B) that is 142 bytes on the wire per chunk, an 11% overhead, or about
4.4 kB/s. An Uno at 115200 baud carries about 11.5 kB/s.

### 3.4 Control

- `hello [4, v]`: "tell me what you are". The board replies with `board`,
  then `ns` `stream` messages. Receiving `hello` always resets the board to
  *idle*.
- `start` / `stop`: begin or pause **all** board → app `data`. A board never
  streams before `start`, so the app can finish reading descriptors first.
- `ping [7, seq]` → `pong [8, seq, t]`: the board echoes `seq` with its current
  time. Lets the app estimate offset and round trip (§5).

### 3.5 Session

```
app                                    board
 │ 00 (flush)                           │   Uno/ESP32 may be resetting here
 │ hello ─────────────────────────────▶ │   app retries every 500 ms, 5 s limit
 │ ◀───────────── board, stream × ns    │
 │ start ─────────────────────────────▶ │
 │ ◀──────────────────────── data …     │
 │ data (sinks) ─────────────────────▶  │
 │ stop ──────────────────────────────▶ │
```

Opening a serial port toggles DTR, which **resets an Uno and most ESP32 dev
boards**, so the board is deaf for 1–2 s. That is what the hello retry loop is
for. On connection loss the board returns to idle; on reconnect the app starts
again from `hello`.

## 4. Worked example

Verified by encoding with `@msgpack/msgpack`, the CRC above and a COBS
encoder. The first three are the descriptors for a board `uno-1` with one
uint16 sensor `pot` at 50 Hz, scale `0.0048828125` (5 V / 1024). All bytes hex.

```
board  [1,{v:1,id:"uno-1",tu:"ms",mf:64,ns:1}]
  20 92 01 85 a1 76 01 a2 69 64 a5 75 6e 6f 2d 31 a2 74 75 a2 6d 73
     a2 6d 66 40 a2 6e 73 01 cf 13 00

stream  [2,{i:0,n:"pot",m:"unknown",c:1,r:50,f:1,k:0.0048828125}]
  06 92 02 87 a1 69 1f a1 6e a3 70 6f 74 a1 6d a7 75 6e 6b 6e 6f 77 6e
     a1 63 01 a1 72 32 a1 66 01 a1 6b ca 3b a0 01 03 d2 51 00

data    [3, 1, 123456, bin(64 00 fe ff b8 0b)]    → int16 100, -2, 3000
  05 94 03 01 ce 07 01 e2 40 c4 06 64 07 fe ff b8 0b 84 ec 00

hello   [4,1]      06 92 04 01 20 06 00
start   [5]        05 91 05 70 66 00
stop    [6]        05 91 06 13 56 00
ping    [7,42]     06 92 07 2a 7a c6 00
pong    [8,42,123456]  05 93 08 2a ce 06 01 e2 40 ed ec 00
```

Note the `data` frame: the `0x00` bytes inside the samples were rewritten by COBS
(`07` markers), which is why `00` only ever terminates a frame. The `stream`
descriptor is 42 bytes on the wire.

These become `protocol/vectors.json`, consumed by both the TypeScript tests and
the C++ tests (§8), so the two sides cannot drift.

## 5. How it maps into yq-data

**Stream identity.** A `stream` message becomes the stream ID
`<board.id>:<m>:raw:<n>`, which `identityFromStreamID` already parses.

**Metadata.** `r` → `samplingRate`, `c` → `channelCount`, `l`/`u` →
`channelInfo`, `q` → `valueType: "categorical"`. The raw descriptors are kept
under `additionalMetadata.arduino`.

**Samples.** Raw ints are converted to `raw*k + o` in a `Float32Array`.

**Time.** `t` is unwrapped (`delta = (t - last) mod 2³²`, accumulated into a
JS number) and, scaled to ms, filed as `deviceTime` — the board's own clock,
never presented as wall time. This is how `RemoteStreamReceiver` already treats
any non-structured-clone transport. Timestamping by ingest time alone would
carry BLE batching jitter, so a later phase uses `ping`/`pong` to estimate the
board-to-host offset.

**App → board.** For each `d: 1` stream the encoder quantises
`round((v - o) / k)`, clamps to the format's range, and chunks to `mf`.

## 6. TypeScript implementation

The code lives beside the existing transport and receiver layers, and reuses
them rather than adding a second path. Everything below exists except
`BluetoothTransport`.

| Piece | File | Notes |
|---|---|---|
| COBS, CRC-16 | `src/transport/framing.ts` | Pure functions. ~40 lines. |
| MessagePack codec | `src/transport/msgpack.ts` | A `WireCodec` over `@msgpack/msgpack`. **Optional peer dependency, loaded with `import()`** like `jszip` and `papaparse`. |
| Byte transport base | `src/transport/byte_transport.ts` | A `BaseTransport` subclass: bytes in → deframe → CRC → codec → `emit()`; `send()` → codec → CRC → COBS → bytes out. Subclasses supply only `write(bytes)` and call `feed(bytes)`. |
| `SerialTransport` | `src/transport/serial.ts` | Web Serial. Takes `baudRate`, optional pre-granted `port`. |
| `BluetoothTransport` | `src/transport/bluetooth.ts` | Web Bluetooth. Defaults to the Nordic UART Service; service and characteristic UUIDs configurable. Writes in `chunkSize` slices (default 20). |
| `Protocol` interface | `src/transport/protocol.ts` | What every protocol provides: `decode`, `encodePacket`, optional `encodeMeta`. Shared with yq-stream. |
| `ArduinoProtocol` | `src/transport/arduino_protocol.ts` | yq-arduino as a `Protocol`. Stateful, one per board, because `data` needs the descriptors. Encodes packets for sinks, routed by `route`. |
| `ArduinoReceiver` | `src/receiver/devices/arduino.ts` | Extends `RemoteStreamReceiver`. `connect()` runs the hello loop; `startStream()`/`stopStream()` send `start`/`stop`; `write()` sends to a sink. **Claims its transport** by setting `transport.protocol`. |
| `SimulatedArduino` | `src/transport/simulated_arduino.ts` | The board's half of the protocol, in memory. Used by the tests; a readable reference for the firmware. |

Changes to existing code:

- **Protocols became a named layer.** `Transport.protocol` records what a link
  speaks; `StreamTransmitter` and `RemoteStreamReceiver` take a `protocol`
  option and otherwise use the transport's, falling back to yq-stream. This
  replaced the loose `encodePacket` / `encodeMeta` / `decode` options. A
  protocol without `encodeMeta` never announces, which is why a transmit node
  on a board's link sends only `data`.
- The JSON protocol was renamed from `yq-data/1` to `yq-stream`
  (`wire.ts` became `stream_protocol.ts`) and the old names were removed, not
  aliased; see [migration.md](migration.md).
- `TransportKind` gains `"serial"` (and `"bluetooth"` with phase 5);
  `structuredClone: false`.
- `package.json`: `@msgpack/msgpack` as an optional peer dependency.
- `README`: a "Microcontrollers" section next to Lab Streaming Layer.

Because the receiver claims the transport, a pipeline reaches a board with a
graph that is still plain JSON:

```ts
{ id: "out", transmit: { transport: "board" } }   // no options
pipeline.attachReceiver("board", board);
pipeline.attachTransport("board", transport);
```

Testing mirrors the LSL tests: a fake `SerialPortLike` (the way
`WebSocketLike` is used) and a **simulated board** (`SimulatedArduino`) that speaks the protocol, so
the whole receiver path runs under Jest with no hardware. A bench entry
measures decode cost at the throughput above.

## 6a. What the app does, which the firmware must tolerate

Taken from the TypeScript implementation (`ArduinoReceiver`, `SerialTransport`),
so the firmware can be written against real behaviour rather than the spec's
intent.

- **A lone `0x00` comes first.** The app writes one delimiter immediately after
  the port opens, before any frame.
- **`hello` repeats.** While waiting for a board to wake, the app sends `hello`
  every 500 ms (configurable). A board must treat each `hello` as "describe
  yourself again from the top" — `board`, then every `stream` — and must not
  assume it will be sent once. It resets the board to idle each time.
- **`stop` on disconnect.** The app sends `stop` before closing the port, so a
  board that is not reset by the close should go quiet.
- **`start` may follow `hello` at any delay**, and `hello` may arrive while
  streaming (an app that reconnected without the port resetting the board).
- **Integer widths.** The app's MessagePack encoder emits the smallest integer
  that fits, so `idx` and `t` arrive as fixint, uint8, uint16 or uint32 — `t = 0`
  is one byte, `t = 4294967295` is five. The board's parser must accept all of
  them. `protocol/vectors.json` has `data` frames at both ends. (The board's
  own encoder may use any width it likes; the app decodes all of them.)
- **Floats.** `k` and `o` should be sent as float32. The app decodes either, and
  uses the float32 value it received when quantising for a sink, so a board
  that dequantises with the same `k` agrees with it. A scale such as `1/255` is
  not exactly representable, so a value exactly halfway between two raw codes
  can round either way; do not depend on it.
- **Sink `data` is in whole samples**, split so that each frame is at most `mf`
  after decoding. `t` is the app's clock in milliseconds modulo 2³², whatever the
  board's own `tu` is; a sink may ignore it.
- **Bad frames are dropped silently** on both sides. The app counts them
  (`transport.stats`), and a noisy link shows up there, not as an exception.

## 7. Arduino library plan (separate repository)

Arduino Library Manager and PlatformIO expect `library.properties` at the
repository root, so the library should be its own repo (working name
`yq-arduino`). This repository keeps the spec and `protocol/vectors.json`; the
library repo copies the vectors in.

**Core rule: depend only on `Stream&`.** `Serial`, `SoftwareSerial`, a
`HardwareSerial` wired to an HM-10 or Bluefruit module, USB CDC, and an ESP32
BLE UART shim are all `Stream`. On AVR, BLE is always an external module that
looks like serial, so AVR needs no BLE code at all. ESP32 gets one small
`Stream` adapter over the Nordic UART Service (NimBLE or the stock BLE library).
ESP32 classic Bluetooth (SPP) cannot be reached from a browser and is out of
scope.

Sketch of the API (not final):

```cpp
#include <YQ.h>

YQBoard yq(Serial, "uno-1");
YQSource pot = yq.source("pot", YQ_UINT16).rate(50).scale(5.0f / 1024);
YQSink   led = yq.sink("led", YQ_UINT8);

void setup() { Serial.begin(115200); yq.begin(); }

void loop() {
  yq.poll();                          // parse input, answer hello/ping
  if (yq.streaming() && due()) pot.push(analogRead(A0));   // buffers, flushes full chunks
  if (led.available()) analogWrite(LED_BUILTIN, led.read());
}
```

- **No heap on AVR.** All buffers are static, sized by compile-time
  `YQ_MAX_FRAME` (default 64 on AVR, 254 elsewhere). The library advertises it
  as `mf`, which is why the field exists.
- Descriptors live in `PROGMEM` on AVR.
- `push()` accumulates into a per-source buffer and emits a `data` frame when it
  fills or on `flush()`; chunk length trades latency for the 14-byte overhead.
- Encoding: hand-writing the subset in §2.3 is about 100 lines and avoids a
  dependency. The `MsgPack` library on GitHub (hideakitai) lists AVR support
  through ArxContainer with small default limits (128-byte packets). I did not
  verify an ESP32 claim from its README. `PacketSerial` provides COBS and SLIP.
  Decide when writing the library; the wire is identical either way.
- Time: `millis()` or `micros()` per `tu`, as `uint32_t`, no conversion.

## 8. Phases

1. **Spec and vectors.** ✅ This document, plus `protocol/vectors.json` and its
   generator `protocol/generate_vectors.js`, which shares no code with `src/`.
2. **Protocol core (TS, no hardware).** ✅ `src/transport/framing.ts`,
   `msgpack.ts`, `byte_transport.ts`, `protocol.ts`, `arduino_protocol.ts`,
   `simulated_arduino.ts`; tests in `tests/unit/arduino_framing.test.ts`.
3. **Serial.** ✅ `SerialTransport`, `ArduinoReceiver` with sinks, the
   `Protocol` layer that lets pipelines reach sinks, README section.
   Tests in `tests/unit/arduino.test.ts` run the real transport against a
   simulated board. **Not done:** a demo page in `demos/`, and any run against
   real hardware or a real browser's Web Serial.
4. **Arduino library.** Source and sink sketches on an Uno and an ESP32,
   running against phase 3. *In progress elsewhere.*
5. **Bluetooth.** `BluetoothTransport` (a `ByteTransport` subclass: it supplies
   `write()` and calls `feed()`) and the ESP32 BLE `Stream` shim.
6. **Clock.** `ArduinoReceiver.ping()` exists and returns the round trip and the
   board's clock. Still to do: an offset estimate that aligns `deviceTime` with
   the page's clock, and a throughput bench.

Phases 2–3 and 4 are independent once the vectors exist, which is the point of
writing them first.

## 9. Open questions

- **Decided:** the class is `ArduinoReceiver`, attached to a pipeline by hand
  like a Muse. Pipeline `receive` nodes build a plain `RemoteStreamReceiver`,
  which cannot do the hello handshake.
- **Decided:** names. Protocols are named after the peer (`yq-stream`,
  `yq-arduino`), transports after the mechanism (`SerialTransport`), codecs
  after the format (`msgpackCodec`). Not "serial" or "wire" for the protocol:
  serial is a transport, and in a sketch `Serial` is the UART and `Wire` is
  I²C. Versions are integers on the wire, never part of the name.
- **BLE chunk size.** 20 is safe but slow. Whether to request a larger MTU is
  something to measure on real ESP32 hardware, not decide here.
- **Float samples.** Excluded from v1. A format code `4 = float32` would be a
  compatible addition if a sensor needs it.

## 10. Considered and rejected

| Option | Why not |
|---|---|
| Firmata | Pin-oriented (analog/digital reads), no timestamps or multi-channel chunks. Right shape of project (protocol + Arduino lib + host lib), wrong data model. |
| Protobuf / nanopb | Needs a code-generation step in the Arduino library's build. MessagePack gives similar compactness with no schema toolchain. |
| CBOR | RFC 8746 typed arrays fit well, but MessagePack has the stronger browser library and Arduino precedent. |
| JSON | Too heavy to build or parse on an AVR. |
| float16 samples | No hardware support on AVR; int16 with scale/offset is exact for ADC data. |
