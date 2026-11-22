# Microcontrollers

`ArduinoReceiver` talks to a board running the yq-data Arduino library, over a
serial port or Bluetooth Low Energy. There is nothing to configure on this side:
the board announces its streams — names, modalities, channel layouts, rates,
scales — and they appear as ordinary yq-data streams.

```ts
const transport = await SerialTransport.request({ baudRate: 115200 });
const board = new ArduinoReceiver(transport);
await board.connect();            // opens the port and waits for the board to describe itself
board.startStream();
board.data.subscribe((packet) => ...);
```

`SerialTransport.request()` shows the browser's port picker and needs a click
handler. To build the board from stored options instead,
`createReceiver("arduino", { link: "serial" })` (or `"bluetooth"`) asks for the
port inside `connect()`. A port the user has granted before reopens without one through
`SerialTransport.granted()`. Chromium browsers only, like the Muse.

Over Bluetooth Low Energy, only the transport changes:

```ts
const transport = await BluetoothTransport.request();
const board = new ArduinoReceiver(transport);
await board.connect();
board.startStream();
```

`request()` shows the browser's chooser, and needs a click handler too. It lists
every device on the Nordic UART Service, which is what `YQBleStream` on an ESP32
and a Bluefruit module both use. Other products use it as well, so narrow the list
if you need to: `{ filters: [{ namePrefix: "YQ" }] }` or
`{ exclusionFilters: [{ namePrefix: "EmotiBit" }] }`. Another UART only needs its
UUIDs: an HM-10 is `{ service: 0xffe0, rx: 0xffe1, tx: 0xffe1 }`.

Three things differ from a cable:

- **Speed.** A web page can neither set nor read the link's MTU. Notifications from
  the board fill whatever was negotiated, but writes from the app stay at 20 bytes
  each unless you set `chunkSize`. Frames that would queue more than
  `maxQueuedBytes` (default 1024) are dropped whole and counted in
  `transport.stats.queueDropped`, so a sink written faster than the link carries
  lags by a bounded amount.
- **Losing the link.** Connections drop, and `transport.isOpen$` tells you. There is
  no automatic reconnect, but no chooser is needed either: calling
  `board.connect()` and `board.startStream()` again is enough. After
  `board.disconnect()`, which closes the transport, use
  `new BluetoothTransport(transport.device)`.
- **No reset.** Connecting does not reset the board, so `hello` is what returns it
  to idle.

This has run against the library compiled with a mock radio, not yet on a real
board or through a real browser's Bluetooth stack.

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
speaks [yq-arduino](transports-and-protocols.md#protocols), so anything else sending there — a
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
on connect. The wire format is pinned by shared test vectors in
`protocol/vectors.json`, which both this package and the Arduino library are
tested against.
