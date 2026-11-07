/**
 * BluetoothTransport, against a simulated device.
 *
 * The transport, framing, CRC, MessagePack, ArduinoProtocol and ArduinoReceiver
 * all run for real. Only the radio is replaced, by a device that holds the page
 * to Web Bluetooth's rules: see simulated_bluetooth.ts.
 */
import {
  ArduinoOptions,
  ArduinoReceiver,
  BluetoothDeviceFilter,
  BluetoothLike,
  BluetoothRequestDeviceOptions,
  BluetoothTransport,
  BluetoothTransportOptions,
  DataPacket,
  NORDIC_UART_RX,
  NORDIC_UART_SERVICE,
  SimulatedArduino,
  SimulatedArduinoOptions,
  SimulatedArduinoStream,
  SimulatedBluetoothDevice,
  SimulatedBluetoothOptions,
  encodeFrame,
  lineFraming,
  loadMsgpack,
  msgpackCodec,
  textCodec,
} from "../../src";

beforeAll(() => loadMsgpack());

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

async function until(condition: () => boolean, timeout = 500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for a condition.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const POT: SimulatedArduinoStream = {
  name: "pot",
  format: "uint16",
  rate: 50,
  scale: 5 / 1024,
};
const LED: SimulatedArduinoStream = { name: "led", format: "uint8", sink: true };

const transports: BluetoothTransport[] = [];

function transportOn(device: SimulatedBluetoothDevice, options: BluetoothTransportOptions = {}) {
  const transport = new BluetoothTransport(device, options);
  transports.push(transport);
  return transport;
}

/** A board, a transport on its Bluetooth device, and a receiver. */
function rig(
  board: Partial<SimulatedArduinoOptions> & { streams: SimulatedArduinoStream[] },
  options: BluetoothTransportOptions = {},
  receiver: ArduinoOptions = {}
) {
  const sim = new SimulatedArduino({ id: "esp32-1", ...board });
  const transport = transportOn(sim.device, options);
  const arduino = new ArduinoReceiver(transport, {
    helloInterval: 10,
    handshakeTimeout: 500,
    ...receiver,
  });
  const packets: DataPacket[] = [];
  arduino.data.subscribe((p) => packets.push(p));
  return { sim, transport, arduino, packets };
}

async function connected(
  board: Partial<SimulatedArduinoOptions> & { streams: SimulatedArduinoStream[] },
  options?: BluetoothTransportOptions,
  receiver?: ArduinoOptions
) {
  const r = rig(board, options, receiver);
  await r.arduino.connect();
  r.arduino.startStream();
  await settle();
  return r;
}

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    transport.close();
    await transport.closed;
  }
});

describe("request", () => {
  function chooser(device = new SimulatedBluetoothDevice()) {
    const calls: BluetoothRequestDeviceOptions[] = [];
    const bluetooth: BluetoothLike = {
      requestDevice: async (options) => {
        calls.push(options);
        return device;
      },
    };
    return { bluetooth, calls };
  }

  it("lists Nordic UART devices by default, and keeps the service reachable", async () => {
    const { bluetooth, calls } = chooser();
    transports.push(await BluetoothTransport.request({ bluetooth }));

    expect(calls).toEqual([
      {
        filters: [{ services: [NORDIC_UART_SERVICE] }],
        optionalServices: [NORDIC_UART_SERVICE],
      },
    ]);
  });

  it("passes filters through, with the UUIDs Web Bluetooth accepts", async () => {
    const { bluetooth, calls } = chooser();
    const filters: BluetoothDeviceFilter[] = [
      { namePrefix: "YQ", services: ["6E400001-B5A3-F393-E0A9-E50E24DCCA9E"] },
    ];
    transports.push(
      await BluetoothTransport.request({
        bluetooth,
        filters,
        exclusionFilters: [{ namePrefix: "EmotiBit" }],
      })
    );

    expect(calls[0].filters).toEqual([{ namePrefix: "YQ", services: [NORDIC_UART_SERVICE] }]);
    expect(calls[0].exclusionFilters).toEqual([{ namePrefix: "EmotiBit" }]);
  });

  it("says what is wrong where there is no Web Bluetooth", async () => {
    await expect(BluetoothTransport.request()).rejects.toThrow(/Web Bluetooth is not available/);
  });

  it("does not swallow the user dismissing the chooser", async () => {
    const bluetooth: BluetoothLike = {
      requestDevice: () => Promise.reject(new Error("User cancelled the requestDevice() chooser.")),
    };
    await expect(BluetoothTransport.request({ bluetooth })).rejects.toThrow(/cancelled/);
  });
});

describe("opening", () => {
  it("is not open until it is subscribed, and flushes the far end first", async () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device);
    expect(transport.kind).toBe("bluetooth");
    expect(transport.structuredClone).toBe(false);
    expect(transport.isOpen).toBe(false);

    await transport.ready();
    await settle();

    expect(transport.isOpen).toBe(true);
    expect(device.subscribed).toBe(true);
    expect(device.writes.map((w) => Array.from(w.bytes))).toEqual([[0]]);
  });

  it("takes UUIDs written the way a sketch writes them", async () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device, {
      service: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
      rx: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E",
      tx: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E",
    });
    await expect(transport.ready()).resolves.toBeUndefined();
  });

  it("opens a UART with one characteristic for both directions, as on an HM-10", async () => {
    const options = { service: 0xffe0, rx: 0xffe1, tx: 0xffe1 };
    const { arduino, sim, packets } = await connected(
      { streams: [POT], bluetooth: options },
      options
    );

    sim.emit("pot", [2.5]);
    await until(() => packets.length === 1);
    expect(arduino.sources.map((s) => s.name)).toEqual(["pot"]);
  });

  it("rejects and lets go of a device without the service, then can try again", async () => {
    const device = new SimulatedBluetoothDevice();
    const wrong = transportOn(device, { service: 0xffe0 });

    await expect(wrong.ready()).rejects.toThrow(/NotFoundError/);
    expect(device.connected).toBe(false);
    expect(wrong.isOpen).toBe(false);

    const right = transportOn(device);
    await expect(right.ready()).resolves.toBeUndefined();
  });

  it("retries on the same transport after a failed attempt", async () => {
    const device = new SimulatedBluetoothDevice();
    const realConnect = device.gatt.connect;
    device.gatt.connect = () => Promise.reject(new Error("NetworkError: out of range."));

    const transport = transportOn(device);
    await expect(transport.ready()).rejects.toThrow(/out of range/);

    device.gatt.connect = realConnect;
    await expect(transport.ready()).resolves.toBeUndefined();
    expect(transport.isOpen).toBe(true);
  });

  it("gives up on a link that never opens", async () => {
    const device = new SimulatedBluetoothDevice({ neverConnects: true });
    const transport = transportOn(device, { connectTimeout: 20 });
    await expect(transport.ready()).rejects.toThrow(/did not open within 20 ms/);
  });

  it("does not come open when closed while connecting", async () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device);
    const opening = transport.ready();
    transport.close();

    await expect(opening).rejects.toThrow(/closed/);
    await transport.closed;
    expect(transport.isOpen).toBe(false);
    expect(device.connected).toBe(false);
  });

  it("refuses a characteristic that cannot be written as asked", async () => {
    const device = new SimulatedBluetoothDevice({ write: false });
    const transport = transportOn(device, { withResponse: true });
    await expect(transport.ready()).rejects.toThrow(/cannot be written/);
    expect(device.connected).toBe(false);
  });

  it("refuses a characteristic that cannot be written at all", async () => {
    const device = new SimulatedBluetoothDevice({ write: false, writeWithoutResponse: false });
    await expect(transportOn(device).ready()).rejects.toThrow(/cannot be written/);
  });
});

describe("writing", () => {
  const long = new Uint8Array(100).fill(7);

  function sent(device: SimulatedBluetoothDevice): number[] {
    return device.writes.flatMap((w) => Array.from(w.bytes));
  }

  it("writes without response when the characteristic allows it", async () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device);
    await transport.ready();
    await settle();
    expect(device.writes.every((w) => !w.withResponse)).toBe(true);
  });

  it("falls back to acknowledged writes on a device that only takes those", async () => {
    // EmotiBit's RX characteristic has only PROPERTY_WRITE.
    const device = new SimulatedBluetoothDevice({ writeWithoutResponse: false });
    const transport = transportOn(device);
    await transport.ready();
    await settle();
    expect(device.writes).toHaveLength(1);
    expect(device.writes[0].withResponse).toBe(true);
  });

  it("can be told to wait for acknowledgements", async () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device, { withResponse: true });
    await transport.ready();
    await settle();
    expect(device.writes[0].withResponse).toBe(true);
  });

  it("splits a frame to fit the MTU, and the bytes rejoin in order", async () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device);
    await transport.ready();
    await settle();
    device.writes.length = 0;

    transport.send(long);
    await until(() => sent(device).length >= 100);

    expect(device.writes.length).toBeGreaterThan(1);
    expect(device.writes.every((w) => w.bytes.length <= 20)).toBe(true);
    const frame = encodeFrame(msgpackCodec.encode(long) as Uint8Array);
    expect(sent(device)).toEqual(Array.from(frame));
  });

  it("honours a larger chunk size", async () => {
    const device = new SimulatedBluetoothDevice({ mtu: 247 });
    const transport = transportOn(device, { chunkSize: 244 });
    await transport.ready();
    await settle();
    device.writes.length = 0;

    transport.send(long);
    await until(() => device.writes.length === 1);
    expect(device.writes[0].bytes.length).toBeGreaterThan(100);
  });

  it("never runs two writes at once, which Web Bluetooth rejects", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const device = new SimulatedBluetoothDevice({ writeDelay: 1 });
    const transport = transportOn(device, { maxQueuedBytes: 4096 });
    await transport.ready();

    for (let i = 0; i < 5; i++) transport.send([i, long]);
    await until(() => sent(device).length > 500, 1000);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not hold a write that fails against the next one", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device, { chunkSize: 100 }); // past this link's 20
    await transport.ready();
    await settle();

    transport.send(long); // too big for one write without response
    transport.send(1); // fits
    await until(() => device.writes.length === 2);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/write failed/), expect.anything());
    warn.mockRestore();
  });

  it("drops whole frames once too many bytes are waiting, and counts them", async () => {
    const device = new SimulatedBluetoothDevice({ writeDelay: 2 });
    const transport = transportOn(device, { maxQueuedBytes: 150 });
    await transport.ready();
    await settle();
    device.writes.length = 0;

    for (let i = 0; i < 5; i++) transport.send(long); // over 100 bytes each
    expect(transport.stats.queueDropped).toBe(4);

    // What does go out is one intact frame: the far end's CRC would pass it.
    const frame = encodeFrame(msgpackCodec.encode(long) as Uint8Array);
    await until(() => sent(device).length >= frame.length, 1000);
    expect(sent(device)).toEqual(Array.from(frame));
  });

  it("takes frames again once the queue has drained", async () => {
    const device = new SimulatedBluetoothDevice({ writeDelay: 1 });
    const transport = transportOn(device, { maxQueuedBytes: 150 });
    await transport.ready();

    transport.send(long);
    transport.send(long);
    expect(transport.stats.queueDropped).toBe(1);

    await settle();
    await until(() => sent(device).length > 100, 1000);
    device.writes.length = 0;
    transport.send(1);
    await until(() => device.writes.length > 0, 1000);
    expect(transport.stats.queueDropped).toBe(1);
  });

  it("sends nothing on a link that is not open", () => {
    const device = new SimulatedBluetoothDevice();
    const transport = transportOn(device);
    transport.send(1);
    expect(device.writes).toEqual([]);
  });
});

describe("yq-arduino over Bluetooth", () => {
  // A descriptor is about 42 bytes, so at the smallest MTU every one spans
  // several notifications. A big MTU puts whole frames in one.
  describe.each([
    ["a byte at a time", 4],
    ["the smallest MTU", 23],
    ["a typical negotiated MTU", 185],
    ["a big MTU", 517],
  ])("on %s", (_label, mtu) => {
    it("runs a handshake, streams and writes to a sink", async () => {
      const { arduino, sim, packets, transport } = await connected(
        { streams: [POT, LED], bluetooth: { mtu } },
        { chunkSize: Math.min(20, mtu - 3) }
      );

      expect(arduino.sources.map((s) => s.name)).toEqual(["pot"]);
      expect(arduino.sinks.map((s) => s.name)).toEqual(["led"]);
      expect(arduino.discoveredStreams).toEqual(["esp32-1:unknown:raw:pot"]);

      sim.emit("pot", [2.5, 1.25]);
      await until(() => packets.length === 1);
      expect(Array.from(packets[0].data)).toEqual([2.5, 1.25]);

      arduino.write("led", 200);
      await until(() => sim.received.length === 1);
      expect(sim.received[0].raw).toEqual([200]);

      const { dropped } = transport.stats;
      expect(Object.values(dropped).reduce((a, b) => a + b, 0)).toBe(0);
    });
  });

  it("carries a full-size frame across many notifications", async () => {
    const samples = Array.from({ length: 120 }, (_, i) => i);
    const { sim, packets } = await connected({
      streams: [{ name: "pot", format: "uint16", rate: 50 }],
    });

    sim.emit("pot", samples);
    await until(() => packets.length === 1);
    expect(Array.from(packets[0].data)).toEqual(samples);
  });

  it("keeps frames apart when several share a notification", async () => {
    const { sim, packets } = await connected({
      streams: [{ name: "pot", format: "uint16", rate: 50 }],
      bluetooth: { mtu: 517 },
    });

    const frame = (value: number) => {
      const bytes = new Uint8Array(2);
      new DataView(bytes.buffer).setUint16(0, value, true);
      return encodeFrame(msgpackCodec.encode([3, 0, 1000, bytes]) as Uint8Array);
    };
    const a = frame(1);
    const b = frame(2);
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    sim.device.notify(both);

    await until(() => packets.length === 2);
    expect(packets.map((p) => p.data[0])).toEqual([1, 2]);
  });

  it("recovers from a frame that lost its end", async () => {
    const { sim, packets, transport } = await connected({ streams: [POT] });

    sim.device.notify(Uint8Array.of(9, 1, 2, 3, 0));
    sim.emit("pot", [2.5]);

    await until(() => packets.length === 1);
    expect(transport.stats.dropped.cobs + transport.stats.dropped.crc).toBe(1);
  });

  it("quiets a board that was left streaming, which a connection does not reset", async () => {
    const r = rig({ streams: [POT] });
    r.sim.streaming = true;

    await r.arduino.connect();
    expect(r.sim.streaming).toBe(false);
    expect(r.packets).toEqual([]);
  });

  it("asks once when the board answers straight away", async () => {
    const { sim } = await connected({ streams: [POT] });
    const hellos = sim.log.filter((m) => m[0] === 4);
    expect(hellos).toHaveLength(1);
  });

  it("answers a ping", async () => {
    const { arduino } = await connected({ streams: [POT], clock: () => 1234 });
    const { deviceTime } = await arduino.ping();
    expect(deviceTime).toBe(1234);
  });

  it("explains a device that does not speak yq-arduino", async () => {
    const { arduino, transport, sim } = rig(
      { streams: [POT], answerHello: false },
      {},
      { handshakeTimeout: 30 }
    );
    await expect(arduino.connect()).rejects.toThrow(/did not describe itself.*yq-arduino/);
    await transport.closed;
    expect(sim.device.connected).toBe(false);
  });

  it("sends stop and lets go of the link on disconnect", async () => {
    const { arduino, sim, transport } = await connected({ streams: [POT] });

    await arduino.disconnect();
    await transport.closed;

    expect(sim.log[sim.log.length - 1]).toEqual([6]);
    expect(sim.device.connected).toBe(false);
    expect(transport.isOpen).toBe(false);
  });

  it("comes back on a new transport with no chooser, after a disconnect", async () => {
    const first = await connected({ streams: [POT] });
    await first.arduino.disconnect();
    await first.transport.closed;
    await expect(first.transport.ready()).rejects.toThrow(/closed/);

    const transport = transportOn(first.sim.device as SimulatedBluetoothDevice);
    const again = new ArduinoReceiver(transport, { helloInterval: 10, handshakeTimeout: 500 });
    await again.connect();
    expect(again.sources.map((s) => s.name)).toEqual(["pot"]);
  });

  describe("when the link drops", () => {
    it("notices, and the board returns to idle", async () => {
      const { arduino, sim, transport } = await connected({ streams: [POT] });
      expect(sim.streaming).toBe(true);

      sim.unplug();

      expect(transport.isOpen).toBe(false);
      expect(arduino.isConnected).toBe(false);
      expect(sim.streaming).toBe(false);
    });

    it("quietly gives up on what was waiting to be written", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { arduino, sim, transport } = await connected(
        { streams: [POT, LED], bluetooth: { writeDelay: 2 } }
      );

      arduino.write("led", [1, 2, 3, 4]);
      sim.unplug();
      await settle();
      await settle();

      expect(warn).not.toHaveBeenCalled();
      expect(transport.isOpen).toBe(false);
      warn.mockRestore();
    });

    it("connects again on the same receiver, without doubling anything", async () => {
      const { arduino, sim, packets, transport } = await connected({
        streams: [{ name: "pot", format: "uint16", rate: 50 }],
      });
      sim.emit("pot", [1]);
      await until(() => packets.length === 1);

      sim.unplug();
      expect(arduino.isConnected).toBe(false);

      await arduino.connect();
      arduino.startStream();
      await settle();
      expect(arduino.isConnected).toBe(true);
      expect(transport.isOpen).toBe(true);
      expect(sim.streaming).toBe(true);

      sim.emit("pot", [2]);
      await until(() => packets.length >= 2);
      await settle();
      expect(packets.map((p) => p.data[0])).toEqual([1, 2]);
    });

    it("forgets a half-received frame across the gap", async () => {
      const { arduino, sim, packets, transport } = await connected({ streams: [POT] });

      const frame = encodeFrame(msgpackCodec.encode([3, 0, 1000, new Uint8Array(2)]) as Uint8Array);
      sim.device.notify(frame.slice(0, 5));
      await settle();
      sim.unplug();

      await arduino.connect();
      arduino.startStream();
      await settle();

      sim.emit("pot", [2.5]);
      await until(() => packets.length === 1);
      expect(packets[0].data[0]).toBe(2.5);
      expect(transport.stats.dropped.cobs + transport.stats.dropped.crc).toBe(0);
    });
  });
});

/**
 * The groundwork for an EmotiBit. It uses the same Nordic UART UUIDs but sends
 * newline-separated CSV, with no CRC, handshake or descriptors. There is no
 * EmotiBit receiver yet: this pins that the transport can carry one. See
 * docs/emotibit-ble.md.
 */
describe("a device that sends lines of text", () => {
  const encoder = new TextEncoder();
  const LINE_A = "531473,17298,3,PI,1,100,112870,112866,112867\n";
  const LINE_B = "531459,17301,2,EA,1,100,0.030269,0.030269\n";

  /** How the firmware is set up in its draft pull request. */
  const FIRMWARE: SimulatedBluetoothOptions = {
    name: "EmotiBit: MD-V6-0000",
    writeWithoutResponse: false,
    mtu: 185,
  };

  async function lines(device: SimulatedBluetoothDevice) {
    const transport = transportOn(device, { framing: lineFraming(), codec: textCodec });
    const received: unknown[] = [];
    transport.onMessage((line) => received.push(line));
    await transport.ready();
    await settle();
    return { transport, received };
  }

  it("delivers lines as strings, whether they share a notification or not", async () => {
    const device = new SimulatedBluetoothDevice(FIRMWARE);
    const { received } = await lines(device);

    device.notify(encoder.encode(LINE_A + LINE_B));
    await settle();
    device.push(encoder.encode(LINE_A)); // split at the MTU, if it needs to be
    await settle();

    expect(received).toEqual([LINE_A.trim(), LINE_B.trim(), LINE_A.trim()]);
  });

  it("rejoins a line split across notifications", async () => {
    const device = new SimulatedBluetoothDevice({ ...FIRMWARE, mtu: 23 });
    const { received } = await lines(device);

    device.push(encoder.encode(LINE_A));
    await settle();

    expect(received).toEqual([LINE_A.trim()]);
  });

  it("writes control lines acknowledged, with no flush byte first", async () => {
    const device = new SimulatedBluetoothDevice(FIRMWARE);
    const { transport } = await lines(device);
    expect(device.writes).toEqual([]);

    transport.send("0,1,0,RB,1,100\n".trim());
    await until(() => device.writes.length > 0);

    const written = device.writes.map((w) => new TextDecoder().decode(w.bytes)).join("");
    expect(written).toBe("0,1,0,RB,1,100\n");
    expect(device.writes.every((w) => w.withResponse)).toBe(true);
  });

  it("runs a truncated line into the next, which its protocol must catch", async () => {
    // The firmware sends up to 512 bytes per notification, the ESP32 core cuts it
    // to the MTU, and the rest is gone. The line that follows has no boundary to
    // stop at, so the result fails a NUM_DATAPOINTS check rather than parsing.
    const device = new SimulatedBluetoothDevice({ ...FIRMWARE, mtu: 23 });
    const { received } = await lines(device);

    device.notify(encoder.encode(LINE_A));
    device.push(encoder.encode(LINE_B));
    await settle();

    expect(received).toEqual([LINE_A.slice(0, 20) + LINE_B.trim()]);
  });

  it("does not disturb the default framing's rules for other links", async () => {
    const device = new SimulatedBluetoothDevice(FIRMWARE);
    const transport = transportOn(device);
    const received: unknown[] = [];
    transport.onMessage((value) => received.push(value));
    await transport.ready();
    await settle();

    device.notify(encoder.encode(LINE_B));
    await settle();

    expect(received).toEqual([]);
    expect(transport.stats.bytes).toBe(LINE_B.length);
  });
});

describe("line framing", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function decode(maxLine?: number) {
    const lines: string[] = [];
    const deframer = lineFraming(maxLine).decoder((body) => lines.push(decoder.decode(body)));
    return { lines, deframer };
  }

  it("adds a line feed on the way out", () => {
    expect(decoder.decode(lineFraming().encode(encoder.encode("abc")))).toBe("abc\n");
  });

  it("refuses a body that would become two lines", () => {
    expect(() => lineFraming().encode(encoder.encode("a\nb"))).toThrow(RangeError);
  });

  it("flushes nothing, because a stray byte would be part of a line", () => {
    expect(lineFraming().flush).toBeUndefined();
  });

  it("handles carriage returns and empty lines", () => {
    const { lines, deframer } = decode();
    deframer.feed(encoder.encode("a\r\n\n\r\nb\n"));
    expect(lines).toEqual(["a", "b"]);
    expect(deframer.stats.frames).toBe(2);
  });

  it("holds a partial line until its end arrives, and reset forgets it", () => {
    const { lines, deframer } = decode();
    deframer.feed(encoder.encode("par"));
    expect(lines).toEqual([]);
    deframer.feed(encoder.encode("tial\nlost"));
    expect(lines).toEqual(["partial"]);

    deframer.reset();
    deframer.feed(encoder.encode("kept\n"));
    expect(lines).toEqual(["partial", "kept"]);
  });

  it("does not hand out a buffer it will reuse", () => {
    const bodies: Uint8Array[] = [];
    const deframer = lineFraming().decoder((body) => bodies.push(body));
    deframer.feed(encoder.encode("one\ntwo\n"));
    expect(bodies.map((b) => decoder.decode(b))).toEqual(["one", "two"]);
  });

  it("drops an overlong line through its line feed, and counts it", () => {
    const { lines, deframer } = decode(4);
    deframer.feed(encoder.encode("toolong\nok\n"));
    expect(lines).toEqual(["ok"]);
    expect(deframer.stats.dropped.length).toBe(1);
  });

  it("takes a line of exactly the limit", () => {
    const { lines, deframer } = decode(4);
    deframer.feed(encoder.encode("four\n"));
    expect(lines).toEqual(["four"]);
  });

  it("copes with multibyte characters split across chunks", () => {
    const { lines, deframer } = decode();
    const bytes = encoder.encode("µV\n");
    deframer.feed(bytes.slice(0, 1));
    deframer.feed(bytes.slice(1));
    expect(lines).toEqual(["µV"]);
  });
});

describe("the service constants", () => {
  it("are in the form Web Bluetooth accepts", () => {
    expect(NORDIC_UART_SERVICE).toBe(NORDIC_UART_SERVICE.toLowerCase());
    expect(NORDIC_UART_RX).toBe(NORDIC_UART_RX.toLowerCase());
  });
});
