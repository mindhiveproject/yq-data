/**
 * Sources that only learn their streams by connecting — LSL, Arduino, a remote
 * peer — built from stored options through `createReceiver`, and described by
 * the pipeline as they turn out to be.
 */
import {
  ArduinoReceiver,
  LSLReceiver,
  MemoryTransport,
  Modality,
  Pipeline,
  RemoteStreamReceiver,
  SimulatedArduino,
  StreamMetadata,
  createReceiver,
  encodeStreamMeta,
  loadMsgpack,
} from "../../src";

beforeAll(() => loadMsgpack());

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

function eegMeta(streamID: string, labels: string[]): StreamMetadata {
  return {
    streamID,
    modality: Modality.EEG,
    samplingRate: 256,
    channelCount: labels.length,
    channelInfo: labels.map((label, index) => ({ index, label })),
  } as StreamMetadata;
}

describe("stored options for link receivers", () => {
  it("lsl: takes the relay address as an option and connects with no argument", async () => {
    const [relayEnd, near] = MemoryTransport.pair();
    const addresses: string[] = [];
    const lsl = createReceiver("lsl", {
      address: "ws://lab:8080",
      transport: (address: string) => {
        addresses.push(address);
        return near;
      },
    });
    expect(lsl).toBeInstanceOf(LSLReceiver);
    await lsl.connect();
    expect(addresses).toEqual(["ws://lab:8080"]);
    await lsl.disconnect();
    relayEnd.close();
  });

  it("remote: needs a url or a transport", () => {
    expect(() => createReceiver("remote")).toThrow(/url/);
    const remote = createReceiver("remote", { url: "ws://peer:9000" });
    expect(remote).toBeInstanceOf(RemoteStreamReceiver);
    expect(remote.isConnected).toBe(false);
  });

  it("arduino: asks for the port on connect(), not when built", async () => {
    const board = new SimulatedArduino({
      id: "uno-1",
      streams: [{ name: "pot", format: "uint16", rate: 50 }],
    });
    let asked = 0;
    const serial = {
      requestPort: async () => {
        asked++;
        return board.port;
      },
      getPorts: async () => [],
    };
    const arduino = createReceiver("arduino", {
      link: "serial",
      linkOptions: { serial },
      helloInterval: 10,
      handshakeTimeout: 500,
    }) as ArduinoReceiver;
    expect(arduino).toBeInstanceOf(ArduinoReceiver);
    expect(asked).toBe(0);

    await arduino.connect();
    expect(asked).toBe(1);
    expect(arduino.sources.map((s) => s.name)).toEqual(["pot"]);
    await arduino.disconnect();
  });

  it("arduino: refuses a link it does not know", () => {
    expect(() => createReceiver("arduino", { link: "carrier-pigeon" })).toThrow(/serial/);
  });

  it("arduino: disconnecting before ever connecting is harmless", async () => {
    const arduino = createReceiver("arduino", { link: "bluetooth" });
    await expect(arduino.disconnect()).resolves.toBeUndefined();
  });
});

describe("expects a device type", () => {
  it("borrows that receiver's streams until the peer announces its own", () => {
    const remote = createReceiver("remote", { url: "ws://peer:9000", expects: "muse" });
    const expected = remote.expectedStreams();
    expect(expected.map((m) => m.modality)).toContain(Modality.EEG);
    expect(expected).toEqual(createReceiver("muse").expectedStreams());

    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "relay", stream: Modality.EEG },
        { id: "bands", method: "band_power" },
      ],
      edges: [{ from: ["eeg"], to: ["bands"] }],
    });
    pipeline.attachReceiver("relay", remote);
    const [bands] = pipeline.describe();
    expect(bands.channels.map((c) => c.label)).toContain("Alpha");
  });

  it("also accepts plain metadata", () => {
    const meta = eegMeta("lab:eeg:raw", ["Cz"]);
    const lsl = createReceiver("lsl", { address: "ws://lab", expects: [meta] });
    expect(lsl.expectedStreams()).toEqual([meta]);
  });
});

describe("describe() follows what a dynamic source actually announces", () => {
  async function relayed(options: Record<string, unknown> = {}) {
    const [peer, near] = MemoryTransport.pair();
    const remote = createReceiver("remote", { transport: near, ...options });
    const pipeline = new Pipeline({ nodes: [{ id: "relay", receiver: "relay" }], edges: [] });
    pipeline.attachReceiver("relay", remote);
    await remote.connect();
    remote.startStream();
    return { peer, remote, pipeline };
  }

  it("explains an unannounced source, then lists what arrives", async () => {
    const { peer, remote, pipeline } = await relayed();
    expect(pipeline.describe()[0].channels).toEqual([]);
    expect(pipeline.describe()[0].reason).toMatch(/streams\$/);

    const changes: number[] = [];
    remote.streams$.subscribe((ids) => changes.push(ids.length));

    peer.send(encodeStreamMeta(eegMeta("headset:eeg:raw", ["TP9", "AF7"])));
    await settle();

    const [eeg] = pipeline.describe();
    expect(eeg.streamID).toBe("headset:eeg:raw");
    expect(eeg.channels.map((c) => c.label)).toEqual(["TP9", "AF7"]);
    expect(changes.length).toBeGreaterThan(1);
    await remote.disconnect();
  });

  it("replaces an expected device with what is really there, unexpected streams included", async () => {
    const { peer, remote, pipeline } = await relayed({ expects: "muse" });
    const before = pipeline.describe().map((d) => d.streamID);
    expect(before.length).toBeGreaterThan(0);

    peer.send(encodeStreamMeta(eegMeta("headset:eeg:raw", ["Cz"])));
    peer.send(
      encodeStreamMeta({
        streamID: "headset:unknown:raw:temperature",
        modality: Modality.UNKNOWN,
        channelCount: 1,
        channelInfo: [{ index: 0, label: "Skin temperature" }],
      } as StreamMetadata)
    );
    await settle();

    const after = pipeline.describe();
    expect(after.map((d) => d.streamID).sort()).toEqual(
      ["headset:eeg:raw", "headset:unknown:raw:temperature"].sort()
    );
    expect(after.find((d) => d.stream === "temperature")?.channels[0].label).toBe(
      "Skin temperature"
    );
    await remote.disconnect();
  });

  it("signals a metadata refinement as well as a new stream", async () => {
    const { peer, remote, pipeline } = await relayed();
    peer.send(encodeStreamMeta({ streamID: "headset:eeg:raw", modality: Modality.EEG } as StreamMetadata));
    await settle();
    expect(pipeline.describe()[0].channels).toEqual([]);

    let emitted = 0;
    remote.streams$.subscribe(() => emitted++);
    emitted = 0;
    peer.send(encodeStreamMeta(eegMeta("headset:eeg:raw", ["Cz", "Pz"])));
    await settle();

    expect(emitted).toBe(1);
    expect(pipeline.describe()[0].channels.map((c) => c.label)).toEqual(["Cz", "Pz"]);
    await remote.disconnect();
  });
});

describe("streams$ on a repeated announcement", () => {
  it("stays quiet when a peer repeats the same metadata", async () => {
    const [peer, near] = MemoryTransport.pair();
    const remote = createReceiver("remote", { transport: near });
    await remote.connect();
    const meta = eegMeta("headset:eeg:raw", ["Cz"]);
    peer.send(encodeStreamMeta(meta));
    await settle();

    let emitted = 0;
    remote.streams$.subscribe(() => emitted++);
    emitted = 0;
    peer.send(encodeStreamMeta(meta));
    await settle();
    expect(emitted).toBe(0);
    await remote.disconnect();
  });
});
