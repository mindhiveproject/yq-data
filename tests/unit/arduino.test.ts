/**
 * ArduinoReceiver end to end, against a simulated board.
 *
 * The whole path runs for real — SerialTransport's read loop, framing, CRC,
 * MessagePack, ArduinoProtocol, RemoteStreamReceiver — with a SimulatedArduino
 * standing where the hardware will. The only thing replaced is the port.
 */
import { Subject } from "rxjs";
import {
  AnalysisMethod,
  ArduinoReceiver,
  ArduinoOptions,
  DataPacket,
  ArduinoProtocol,
  Modality,
  Pipeline,
  SerialTransport,
  SimulatedArduino,
  SimulatedArduinoOptions,
  SimulatedArduinoStream,
  StreamTransmitter,
  StreamMetadata,
  loadMsgpack,
} from "../../src";

beforeAll(() => loadMsgpack());

const POT: SimulatedArduinoStream = {
  name: "pot",
  format: "uint16",
  rate: 50,
  scale: 5 / 1024,
};

const rigs: Array<{ arduino: ArduinoReceiver; transport: SerialTransport }> = [];

/** A board, a transport on its port, and a receiver, with test-sized timings. */
function rig(
  board: Partial<SimulatedArduinoOptions> & { streams: SimulatedArduinoStream[] },
  options: ArduinoOptions = {}
) {
  const device = new SimulatedArduino({ id: "uno-1", ...board });
  const transport = new SerialTransport(device.port);
  const arduino = new ArduinoReceiver(transport, {
    helloInterval: 10,
    handshakeTimeout: 500,
    ...options,
  });
  const packets: DataPacket[] = [];
  arduino.data.subscribe((p) => packets.push(p));
  rigs.push({ arduino, transport });
  return { device, transport, arduino, packets };
}

async function connected(
  board: Partial<SimulatedArduinoOptions> & { streams: SimulatedArduinoStream[] },
  options?: ArduinoOptions
) {
  const r = rig(board, options);
  await r.arduino.connect();
  r.arduino.startStream();
  await settle();
  return r;
}

/** Lets the simulated port deliver whatever was just sent. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

async function until(condition: () => boolean, timeout = 500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for a condition.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

afterEach(async () => {
  for (const { arduino, transport } of rigs.splice(0)) {
    await arduino.disconnect();
    await transport.closed;
  }
  jest.restoreAllMocks();
});

describe("handshake", () => {
  it("registers the streams the board announces", async () => {
    const { arduino } = await connected({
      streams: [
        POT,
        {
          name: "imu",
          modality: Modality.ACCELEROMETER,
          channels: 3,
          rate: 100,
          scale: 1 / 2048,
          labels: ["x", "y", "z"],
          unit: "g",
        },
      ],
    });

    expect(arduino.streams.sort()).toEqual([
      "uno-1:accelerometer:raw:imu",
      "uno-1:unknown:raw:pot",
    ]);

    const imu = arduino.getStreamMeta("uno-1:accelerometer:raw:imu")!;
    expect(imu.modality).toBe(Modality.ACCELEROMETER);
    expect(imu.samplingRate).toBe(100);
    expect(imu.channelCount).toBe(3);
    expect(imu.channelInfo).toEqual([
      { index: 0, label: "x", unit: "g" },
      { index: 1, label: "y", unit: "g" },
      { index: 2, label: "z", unit: "g" },
    ]);
    expect(imu.deviceInfo?.id).toBe("uno-1");
  });

  it("takes the board's own id as the device id", async () => {
    const { arduino } = await connected({ id: "rig-7", streams: [POT] });
    expect(arduino.deviceID).toBe("rig-7");
    expect(arduino.streams).toEqual(["rig-7:unknown:raw:pot"]);
  });

  it("labels an unlabelled multichannel stream by its name", async () => {
    const { arduino } = await connected({
      streams: [{ name: "adc", channels: 2 }],
    });
    const meta = arduino.getStreamMeta("uno-1:unknown:raw:adc")!;
    expect(meta.channelInfo?.map((c) => c.label)).toEqual(["adc 1", "adc 2"]);
  });

  it("keeps the board's description in the metadata", async () => {
    const { arduino } = await connected({
      name: "Bench Uno",
      firmware: "0.1.0",
      streams: [POT],
    });
    const meta = arduino.getStreamMeta("uno-1:unknown:raw:pot")!;
    expect(meta.additionalMetadata?.arduino).toMatchObject({
      index: 0,
      format: "uint16",
      scale: 5 / 1024,
      board: "Bench Uno",
      firmware: "0.1.0",
    });
  });

  it("survives a board that is still rebooting when the port opens", async () => {
    const started = Date.now();
    const { arduino } = await connected({ bootDelay: 80, streams: [POT] });

    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(arduino.isConnected).toBe(true);
    expect(arduino.streams).toHaveLength(1);
  });

  it("rejects, and closes, when the board never answers", async () => {
    const { arduino, transport } = rig(
      { answerHello: false, streams: [POT] },
      { handshakeTimeout: 80 }
    );

    await expect(arduino.connect()).rejects.toThrow(/did not describe itself/);
    expect(arduino.isConnected).toBe(false);
    expect(transport.isOpen).toBe(false);
  });

  it("rejects a board that speaks another protocol version", async () => {
    const { arduino } = rig({ protocolVersion: 2, streams: [POT] });
    await expect(arduino.connect()).rejects.toThrow(/yq-arduino v2/);
    expect(arduino.streams).toEqual([]);
  });

  it("registers nothing it was not told about", async () => {
    const { arduino } = await connected({ streams: [] });
    expect(arduino.streams).toEqual([]);
  });
});

describe("sources", () => {
  it("publishes nothing until startStream, and tells the board to start", async () => {
    const { device, arduino, packets } = rig({ streams: [POT] });
    await arduino.connect();

    expect(device.streaming).toBe(false);
    device.emit("pot", [1]);
    await settle();
    expect(packets).toHaveLength(0);

    arduino.startStream();
    await settle();
    expect(device.streaming).toBe(true);

    device.emit("pot", [2.5]);
    await until(() => packets.length === 1);
    expect(packets[0].streamID).toBe("uno-1:unknown:raw:pot");
  });

  it("converts raw samples with the stream's scale", async () => {
    const { device, packets } = await connected({ streams: [POT] });

    device.emit("pot", [0, 2.5, 5 * (1023 / 1024)]);
    await until(() => packets.length === 1);

    expect(Array.from(packets[0].data)).toEqual([0, 2.5, 5 * (1023 / 1024)]);
    expect(packets[0].data).toBeInstanceOf(Float32Array);
  });

  it("applies the offset, and reads signed samples", async () => {
    const { device, packets } = await connected({
      streams: [
        {
          name: "temp",
          modality: Modality.TEMPERATURE,
          rate: 1,
          scale: 0.01,
          offset: 20,
        },
      ],
    });

    device.emit("temp", [21.37, 18.5, -5]);
    await until(() => packets.length === 1);

    const [a, b, c] = Array.from(packets[0].data);
    expect(a).toBeCloseTo(21.37, 5);
    expect(b).toBeCloseTo(18.5, 5);
    expect(c).toBeCloseTo(-5, 5);
  });

  it("keeps samples interleaved across channels", async () => {
    const { device, packets } = await connected({
      streams: [{ name: "imu", channels: 3, rate: 100, scale: 0.5 }],
    });

    device.emit("imu", [1, 2, 3, 4, 5, 6]);
    await until(() => packets.length === 1);

    expect(Array.from(packets[0].data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(packets[0].metadata.channelCount).toBe(3);
  });

  it("splits a long burst across frames without losing or reordering samples", async () => {
    const { device, packets } = await connected({
      streams: [{ name: "eeg", channels: 4, rate: 250 }],
    });

    const values = Array.from({ length: 4 * 100 }, (_, i) => i - 200);
    device.emit("eeg", values);
    await until(() => packets.reduce((n, p) => n + p.data.length, 0) === values.length);

    expect(packets.length).toBeGreaterThan(1);
    const joined = packets.flatMap((p) => Array.from(p.data));
    expect(joined).toEqual(values);
  });

  it("represents a categorical stream as markers", async () => {
    const { device, arduino, packets } = await connected({
      streams: [
        {
          name: "button",
          modality: Modality.EVENT_MARKER,
          categories: ["released", "pressed"],
          format: "uint8",
          rate: 100, // ignored: a categorical stream has no rate
        },
      ],
    });

    const meta = arduino.getStreamMeta("uno-1:event_marker:raw:button")!;
    expect(meta.valueType).toBe("categorical");
    expect(meta.samplingRate).toBeUndefined();

    device.emitRaw("button", [1]);
    device.emitRaw("button", [0]);
    await until(() => packets.length === 2);

    expect(Array.from(packets[0].data)).toEqual([2]);
    expect(packets[0].labels).toEqual(["pressed"]);
    expect(packets[1].labels).toEqual(["released"]);
  });

  it("leaves the rate off an irregular stream", async () => {
    const { arduino } = await connected({
      streams: [{ name: "tap", format: "uint8" }],
    });
    expect(arduino.getStreamMeta("uno-1:unknown:raw:tap")!.samplingRate).toBeUndefined();
  });

  it("files board time under deviceTime and stamps arrival itself", async () => {
    const { device, packets } = await connected({ streams: [POT] });

    const before = Date.now();
    device.emit("pot", [1], 5000);
    await until(() => packets.length === 1);

    expect(packets[0].deviceTime).toBe(5000);
    expect(packets[0].timestamp).toBeGreaterThanOrEqual(before);
  });

  it("unwraps the board's 32-bit clock across rollover", async () => {
    const { device, packets } = await connected({ streams: [POT] });

    device.emit("pot", [1], 4294967290);
    device.emit("pot", [1], 10);
    device.emit("pot", [1], 30);
    await until(() => packets.length === 3);

    const times = packets.map((p) => p.deviceTime!);
    expect(times[1] - times[0]).toBe(16);
    expect(times[2] - times[1]).toBe(20);
  });

  it("reads microseconds as milliseconds", async () => {
    const { device, packets } = await connected({ timeUnit: "us", streams: [POT] });

    device.emit("pot", [1], 2500);
    await until(() => packets.length === 1);

    expect(packets[0].deviceTime).toBe(2.5);
  });

  it("recovers from line noise between frames", async () => {
    const { device, transport, packets } = await connected({ streams: [POT] });

    device.noise(Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x00));
    device.emit("pot", [2.5]);
    await until(() => packets.length === 1);

    expect(Array.from(packets[0].data)).toEqual([2.5]);
    const dropped = Object.values(transport.stats.dropped).reduce((a, b) => a + b, 0);
    expect(dropped).toBeGreaterThan(0);
  });

  it("ignores data for a stream it was never told about", async () => {
    const { arduino } = await connected({ streams: [POT] });

    const stray = arduino.protocol.decode([3, 9, 0, Uint8Array.of(1, 0)]);
    expect(stray).toEqual([]);
    expect(arduino.protocol.stats.unknownStream).toBe(1);
  });

  it("ignores a payload that is not a whole number of samples", async () => {
    const { arduino } = await connected({ streams: [POT] });

    const out = arduino.protocol.decode([3, 0, 0, Uint8Array.of(1, 0, 2)]);
    expect(out).toEqual([]);
    expect(arduino.protocol.stats.badPayload).toBe(1);
  });
});

describe("sinks", () => {
  const LED: SimulatedArduinoStream = { name: "led", sink: true, format: "uint8" };

  it("announces sinks without publishing a stream for them", async () => {
    const { arduino } = await connected({ streams: [POT, LED] });

    expect(arduino.sinks.map((s) => s.name)).toEqual(["led"]);
    expect(arduino.sources.map((s) => s.name)).toEqual(["pot"]);
    expect(arduino.streams).toEqual(["uno-1:unknown:raw:pot"]);
  });

  it("writes a value to a sink", async () => {
    const { device, arduino } = await connected({ streams: [LED] });

    arduino.write("led", 200);
    await until(() => device.received.length === 1);

    expect(device.received[0]).toMatchObject({ stream: "led", raw: [200], values: [200] });
  });

  it("quantises with the sink's scale and offset, and clamps to its format", async () => {
    const { device, arduino } = await connected({
      streams: [{ name: "pwm", sink: true, format: "uint8", scale: 1 / 255 }],
    });

    // 0.6 rather than 0.5: half of 255 is a tie, and the scale is float32 on the wire.
    arduino.write("pwm", [0, 0.6, 1, 7, -3, NaN]);
    await until(() => device.received.length === 1);

    expect(device.received[0].raw).toEqual([0, 153, 255, 255, 0, 0]);
  });

  it("writes signed 16-bit values", async () => {
    const { device, arduino } = await connected({
      streams: [{ name: "dac", sink: true, format: "int16" }],
    });

    arduino.write("dac", [-32768, -1, 0, 32767, 99999]);
    await until(() => device.received.length === 1);

    expect(device.received[0].raw).toEqual([-32768, -1, 0, 32767, 32767]);
  });

  it("keeps channels interleaved", async () => {
    const { device, arduino } = await connected({
      streams: [{ name: "rgb", sink: true, channels: 3, format: "uint8" }],
    });

    arduino.write("rgb", [255, 0, 0, 0, 255, 0]);
    await until(() => device.received.length === 1);

    expect(device.received[0].raw).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it("splits a write across frames to fit a small board's buffer", async () => {
    const { device, arduino } = await connected({
      maxFrame: 64,
      streams: [{ name: "strip", sink: true, format: "uint8" }],
    });

    const values = Array.from({ length: 200 }, (_, i) => i);
    arduino.write("strip", values);
    await until(() => device.received.reduce((n, r) => n + r.raw.length, 0) === 200);

    expect(device.received.length).toBeGreaterThan(1);
    // 64-byte frames leave 50 bytes of samples after the headers and CRC.
    for (const receipt of device.received) {
      expect(receipt.raw.length).toBeLessThanOrEqual(50);
    }
    expect(device.received.flatMap((r) => r.raw)).toEqual(values);
  });

  it("warns, and does not throw, for a sink the board does not have", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { arduino } = await connected({ streams: [LED] });

    expect(() => arduino.write("motor", 1)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("does not let a source be written to", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const { device, arduino } = await connected({ streams: [POT] });

    arduino.write("pot", 1);
    await settle();
    expect(device.received).toEqual([]);
  });

  describe("through a transmitter", () => {
    function packet(name: string, values: number[]): DataPacket {
      const metadata: StreamMetadata = {
        streamID: `app-1:unknown:raw:${name}`,
        modality: Modality.UNKNOWN,
        name,
        channelCount: 1,
      };
      return {
        streamID: metadata.streamID,
        timestamp: Date.now(),
        data: Float32Array.from(values),
        metadata,
      };
    }

    function transmitter(transport: SerialTransport) {
      const source = new Subject<DataPacket>();
      const out = new StreamTransmitter(transport);
      out.addSource(source);
      out.start();
      return source;
    }

    it("sends packets to the sink named like their stream, and skips the rest", async () => {
      const { device, transport } = await connected({ streams: [LED] });
      const send = jest.spyOn(transport, "send");
      // A plain transmitter: the receiver has claimed the transport.
      const source = transmitter(transport);

      source.next(packet("led", [128]));
      source.next(packet("elsewhere", [1, 2, 3]));
      await until(() => device.received.length === 1);
      await settle();

      expect(device.received).toHaveLength(1);
      expect(device.received[0].raw).toEqual([128]);
      // One message in total: no `meta`, and nothing for the skipped stream.
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("claims the transport for the board's protocol", async () => {
      const { arduino, transport } = await connected({ streams: [LED] });
      expect(transport.protocol).toBe(arduino.protocol);
      expect(transport.protocol?.name).toBe("yq-arduino");
    });

    it("routes by a table of stream IDs", async () => {
      const { device, transport } = await connected(
        { streams: [LED] },
        { route: { "app-1:unknown:raw:brightness": "led" } }
      );

      transmitter(transport).next(packet("brightness", [77]));
      await until(() => device.received.length === 1);

      expect(device.received[0].raw).toEqual([77]);
    });

    it("routes by a function, settable after construction", async () => {
      const { device, arduino, transport } = await connected({ streams: [LED] });
      arduino.protocol.route = (p) => (p.metadata.name === "x" ? "led" : undefined);
      const source = transmitter(transport);

      source.next(packet("x", [5]));
      source.next(packet("y", [6]));
      await until(() => device.received.length === 1);
      await settle();

      expect(device.received.map((r) => r.raw)).toEqual([[5]]);
    });

    it("splits a packet too large for one frame, in order", async () => {
      const { device, transport } = await connected({
        maxFrame: 64,
        streams: [{ name: "strip", sink: true, format: "uint8" }],
      });

      const values = Array.from({ length: 120 }, (_, i) => i);
      transmitter(transport).next(packet("strip", values));
      await until(() => device.received.reduce((n, r) => n + r.raw.length, 0) === 120);

      expect(device.received.length).toBeGreaterThan(1);
      expect(device.received.flatMap((r) => r.raw)).toEqual(values);
    });

    it("closes the loop in a graph with no options: sensor -> analysis -> actuator", async () => {
      const { device, arduino, transport } = await connected(
        { streams: [POT, { name: "led", sink: true, format: "uint8", scale: 1 / 255 }] },
        { route: () => "led" }
      );

      // Plain JSON throughout — nothing in the graph but keys.
      const graph = JSON.parse(
        JSON.stringify({
          nodes: [
            { id: "pot", receiver: "board" },
            {
              id: "norm",
              method: AnalysisMethod.NORMALIZATION,
              parameters: { mode: "fixed", min: 0, max: 5 },
            },
            { id: "out", transmit: { transport: "board" } },
          ],
          edges: [
            { from: ["pot"], to: ["norm"] },
            { from: ["norm"], to: ["out"] },
          ],
        })
      );
      const pipeline = new Pipeline(graph);
      pipeline.attachReceiver("board", arduino);
      pipeline.attachTransport("board", transport);
      pipeline.start();

      device.emit("pot", [3]);
      await until(() => device.received.length === 1);

      // 3 of 0..5 is 0.6, which the sink's 1/255 scale makes 153.
      expect(device.received[0].raw).toEqual([153]);
      // Nothing went out that the board could not read.
      expect(transport.stats.oversize).toBe(0);
      expect(device.stats.dropped.decode).toBe(0);
      expect(device.log.every(Array.isArray)).toBe(true);
    });
  });
});

describe("lifecycle", () => {
  it("answers a ping with a round trip and the board's clock", async () => {
    const { arduino } = await connected({ streams: [POT], clock: () => 4242 });

    const { roundTrip, deviceTime } = await arduino.ping();
    expect(deviceTime).toBe(4242);
    expect(roundTrip).toBeGreaterThanOrEqual(0);
  });

  it("rejects a ping the board never answers", async () => {
    const { arduino, device } = await connected({ streams: [POT] });
    device.port.onWrite = () => {}; // the board goes deaf

    await expect(arduino.ping(30)).rejects.toThrow(/did not answer ping/);
  });

  it("stops the board when it disconnects", async () => {
    const { device, arduino } = await connected({ streams: [POT] });
    expect(device.streaming).toBe(true);

    await arduino.disconnect();
    await until(() => !device.streaming);

    expect(device.log.map((m) => m[0])).toContain(6);
  });

  it("stops the board on stopStream and stays connected", async () => {
    const { device, arduino, packets } = await connected({ streams: [POT] });

    arduino.stopStream();
    await until(() => !device.streaming);
    device.emit("pot", [1]);
    await settle();

    expect(packets).toHaveLength(0);
    expect(arduino.isConnected).toBe(true);
  });

  it("notices when the cable is pulled", async () => {
    const { device, arduino, transport } = await connected({ streams: [POT] });

    device.unplug();
    await until(() => !arduino.isConnected);

    expect(transport.isOpen).toBe(false);
  });

  it("can connect again on a fresh transport after a disconnect", async () => {
    const first = await connected({ streams: [POT] });
    await first.arduino.disconnect();
    await first.transport.closed;

    const second = await connected({ streams: [POT] });
    second.device.emit("pot", [2.5]);
    await until(() => second.packets.length === 1);
  });

  it("parses the same message the framing layer test vectors carry", () => {
    // The protocol needs no transport at all: arrays in, updates out.
    const session = new ArduinoProtocol();
    session.decode([1, { v: 1, id: "uno-1", tu: "ms", mf: 64, ns: 1 }]);
    const [meta] = session.decode([
      2,
      { i: 0, n: "pot", m: "unknown", c: 1, r: 50, f: 1, k: 0.0048828125 },
    ]);
    expect(meta).toMatchObject({
      kind: "meta",
      streamID: "uno-1:unknown:raw:pot",
      metadata: { samplingRate: 50, channelCount: 1 },
    });
    expect(session.ready).toBe(true);
    expect(session.maxFrame).toBe(64);
  });
});
