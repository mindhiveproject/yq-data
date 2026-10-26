/**
 * LSL stream registration and decoding.
 *
 * The receiver runs for real — transport, protocol, registration — with an
 * in-memory link standing where the relay's WebSocket would be: what is under
 * test is how a relay's JSON becomes packets, and a real socket would add
 * nothing but a server to tear down.
 */
import {
  AnalysisMethod,
  DataPacket,
  LSLProtocol,
  LSLReceiver,
  MemoryTransport,
  Modality,
  Pipeline,
  Protocol,
  RemoteStreamReceiver,
  canConnect,
  compatibleMethods,
  registeredMethods,
} from "../../src";

/** The relay's end of each receiver's link, so `send` can speak as the relay. */
const relays = new WeakMap<LSLReceiver, MemoryTransport>();

/** An LSL receiver connected to an in-memory relay, and streaming. */
async function relay(): Promise<LSLReceiver> {
  const [relayEnd, near] = MemoryTransport.pair();
  const receiver = new LSLReceiver({ transport: () => near });
  await receiver.connect("memory://relay");
  receiver.startStream();
  relays.set(receiver, relayEnd);
  return receiver;
}

/** Feeds one relay message in, as the relay would send it. */
function send(receiver: LSLReceiver, payload: unknown): void {
  relays.get(receiver)!.send(payload);
}

const MARKER_INFO = {
  name: "trials",
  type: "Markers",
  channel_count: 1,
  // 3 is LSL's string format, which is what a marker outlet actually uses.
  channel_format: 3,
  source_id: "psychopy-1",
};

describe("LSL marker streams", () => {
  it("registers a string-format marker stream instead of dropping it", async () => {
    const receiver = await relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    expect(receiver.discoveredStreams).toEqual(["trials"]);
    expect(receiver.streams).toHaveLength(1);
  });

  it("declares itself categorical and rate-free", async () => {
    const receiver = await relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const meta = receiver.getStreamMeta(receiver.streams[0])!;
    expect(meta.modality).toBe(Modality.EVENT_MARKER);
    expect(meta.valueType).toBe("categorical");
    expect(meta.samplingRate).toBeUndefined();
    expect(meta.channelCount).toBe(1);
  });

  it("ignores a nominal rate the relay reports for markers", async () => {
    const receiver = await relay();
    send(receiver, {
      trials: { info: { ...MARKER_INFO, nominal_srate: 10 } },
    });

    const meta = receiver.getStreamMeta(receiver.streams[0])!;
    expect(meta.samplingRate).toBeUndefined();
  });

  it("carries the label and assigns a stable numeric code", async () => {
    const receiver = await relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { trials: { timeseries: ["go"], timestamp: 100 } });
    send(receiver, { trials: { timeseries: ["stop"], timestamp: 101 } });
    send(receiver, { trials: { timeseries: ["go"], timestamp: 102 } });

    expect(seen.map((p) => p.labels?.[0])).toEqual(["go", "stop", "go"]);
    expect(seen.map((p) => p.data[0])).toEqual([1, 2, 1]);
    expect(seen[0].metadata.additionalMetadata?.markerCodes).toEqual({
      go: 1,
      stop: 2,
    });
  });

  it("accepts markers nested one per channel, as some relays send them", async () => {
    const receiver = await relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { trials: { timeseries: [["go"], ["stop"]] } });

    expect(seen).toHaveLength(1);
    expect(seen[0].labels).toEqual(["go", "stop"]);
  });

  it("keeps the LSL clock in deviceTime rather than timestamp", async () => {
    const receiver = await relay();
    send(receiver, { trials: { info: MARKER_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { trials: { timeseries: ["go"], timestamp: 12.5 } });

    // Seconds in the sender's domain, converted to ms but not claimed as ours.
    expect(seen[0].deviceTime).toBe(12500);
    expect(seen[0].timestamp).not.toBe(12500);
  });

  it("is refused by every analyzing node, exactly like an in-page marker", async () => {
    const receiver = await relay();
    send(receiver, { trials: { info: MARKER_INFO } });
    const meta = receiver.getStreamMeta(receiver.streams[0])!;

    // This is the bug that prompted the fix: without valueType these four
    // would have averaged marker codes into a meaningless number.
    for (const method of [
      AnalysisMethod.NORMALIZATION,
      AnalysisMethod.STATISTICAL_FEATURES,
      AnalysisMethod.CHANNEL_SELECTION,
      AnalysisMethod.RMS,
    ]) {
      expect(canConnect(meta, method)).toMatch(/labels rather than measurements/);
    }

    expect(compatibleMethods(meta, registeredMethods())).toEqual([
      AnalysisMethod.STREAM_SELECTION,
    ]);
  });
});

describe("LSL ordinary streams", () => {
  const EEG_INFO = {
    name: "BioSemi",
    type: "EEG",
    channel_count: 2,
    channel_format: 1,
    nominal_srate: 256,
    source_id: "biosemi-1",
  };

  it("keeps its rate and stays numeric", async () => {
    const receiver = await relay();
    send(receiver, { eeg: { info: EEG_INFO } });

    const meta = receiver.getStreamMeta(receiver.streams[0])!;
    expect(meta.modality).toBe(Modality.EEG);
    expect(meta.samplingRate).toBe(256);
    expect(meta.valueType).toBeUndefined();
    expect(canConnect(meta, AnalysisMethod.FILTERING)).toBe(true);
  });

  it("forwards samples unchanged", async () => {
    const receiver = await relay();
    send(receiver, { eeg: { info: EEG_INFO } });

    const seen: DataPacket[] = [];
    receiver.data.subscribe((packet) => seen.push(packet));

    send(receiver, { eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } });

    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
    expect(seen[0].labels).toBeUndefined();
  });

  it("still refuses a genuinely non-numeric stream", async () => {
    const receiver = await relay();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    send(receiver, {
      notes: { info: { name: "notes", type: "Text", channel_format: 3 } },
    });

    expect(receiver.streams).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("LSL streams in a pipeline", () => {
  const EEG_INFO = {
    name: "BioSemi",
    type: "EEG",
    channel_count: 2,
    channel_format: 1,
    nominal_srate: 256,
    source_id: "biosemi-1",
  };

  it("resolves a source node's stream against IDs named for the source device", async () => {
    const receiver = await relay();
    const pipeline = new Pipeline({
      nodes: [{ id: "eeg", receiver: "lsl", stream: Modality.EEG }],
      edges: [],
    });
    pipeline.attachReceiver("lsl", receiver);
    pipeline.start();

    const seen: DataPacket[] = [];
    pipeline.getOutput("eeg").subscribe((p) => seen.push(p));

    // A relay registers each stream under its *source's* ID — "biosemi-1"
    // here, never the receiver's own "LSL" — and only once it has been
    // discovered. Both defeat resolving the shortcut by constructed ID.
    send(receiver, { eeg: { info: EEG_INFO } });
    send(receiver, { eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } });

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("biosemi-1:eeg:raw:BioSemi");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
  });

  it("keeps a marker outlet off a node that cannot read it", async () => {
    const receiver = await relay();
    send(receiver, { eeg: { info: EEG_INFO } });
    send(receiver, { trials: { info: MARKER_INFO } });

    const pipeline = new Pipeline({
      nodes: [
        { id: "lsl", receiver: "lsl" },
        { id: "power", method: AnalysisMethod.BAND_POWER },
      ],
      edges: [{ from: ["lsl"], to: ["power"] }],
    });
    pipeline.attachReceiver("lsl", receiver);

    // The relay's two streams disagree about what band power can do with
    // them, and the graph is judged on the set rather than on whichever
    // stream happened to be announced first.
    const issues = pipeline.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].reason).toMatch(/1 of 2 streams on this edge/);
  });
});

describe("LSLProtocol on its own", () => {
  const EEG_INFO = {
    name: "BioSemi",
    type: "EEG",
    channel_count: 2,
    channel_format: 1,
    nominal_srate: 256,
    source_id: "biosemi-1",
  };

  it("needs no receiver or transport: JSON in, stream updates out", () => {
    const protocol = new LSLProtocol();

    const [meta] = protocol.decode({ eeg: { info: EEG_INFO } });
    expect(meta).toMatchObject({
      kind: "meta",
      streamID: "biosemi-1:eeg:raw:BioSemi",
      metadata: { modality: "eeg", samplingRate: 256, channelCount: 2 },
    });

    const [packet] = protocol.decode({ eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } });
    expect(packet).toMatchObject({
      kind: "packet",
      streamID: "biosemi-1:eeg:raw:BioSemi",
      deviceTime: 5000,
    });
  });

  it("is named for its peer, and is decode-only", () => {
    const protocol = new LSLProtocol();
    expect(protocol.name).toBe("lsl");
    expect(protocol.version).toBe(1);
    expect(protocol.encodePacket()).toEqual([]);
    // No metadata message either: nothing is announced back.
    expect((protocol as Protocol).encodeMeta).toBeUndefined();
  });

  it("knows a stream only after its info has arrived", () => {
    const protocol = new LSLProtocol();
    expect(protocol.decode({ eeg: { timeseries: [1, 2], timestamp: 1 } })).toEqual([]);
    expect(protocol.streamKeys).toEqual([]);

    protocol.decode({ eeg: { info: EEG_INFO } });
    expect(protocol.streamKeys).toEqual(["eeg"]);
  });

  it("does not announce a stream twice", () => {
    const protocol = new LSLProtocol();
    expect(protocol.decode({ eeg: { info: EEG_INFO } })).toHaveLength(1);
    expect(protocol.decode({ eeg: { info: EEG_INFO } })).toEqual([]);
  });

  it("does not give a marker label a code while samples are being dropped", () => {
    const protocol = new LSLProtocol();
    protocol.decode({ trials: { info: MARKER_INFO } });

    // Before startStream(): the receiver tells the decoder nothing will be kept.
    protocol.decode({ trials: { timeseries: ["early"], timestamp: 1 } }, { streaming: false });
    const [packet] = protocol.decode(
      { trials: { timeseries: ["go"], timestamp: 2 } },
      { streaming: true }
    );

    expect(packet).toMatchObject({ labels: ["go"], data: [1] });
  });

  it("handles several streams in one message", () => {
    const protocol = new LSLProtocol();
    const updates = protocol.decode({
      eeg: { info: EEG_INFO },
      trials: { info: MARKER_INFO },
    });
    expect(updates.map((u) => u.streamID)).toEqual([
      "biosemi-1:eeg:raw:BioSemi",
      "psychopy-1:event_marker:raw:trials",
    ]);
  });

  it("keeps ':' out of the identity it builds", () => {
    const protocol = new LSLProtocol();
    const [meta] = protocol.decode({
      odd: { info: { ...EEG_INFO, name: "a:b", source_id: "c:d" } },
    });
    expect(meta.streamID).toBe("c_d:eeg:raw:a_b");
  });

  it("forgets everything on reset", () => {
    const protocol = new LSLProtocol();
    protocol.decode({ trials: { info: MARKER_INFO } });
    protocol.reset();
    expect(protocol.streamKeys).toEqual([]);
  });
});

describe("LSLReceiver connection", () => {
  it("passes the address to the transport and remembers it", async () => {
    const addresses: string[] = [];
    const receiver = new LSLReceiver({
      transport: (address) => {
        addresses.push(address);
        return MemoryTransport.pair()[0];
      },
    });

    await receiver.connect("ws://lab:8080");
    await receiver.disconnect();
    await receiver.connect(); // no address: reuse

    expect(addresses).toEqual(["ws://lab:8080", "ws://lab:8080"]);
  });

  it("can connect again after a disconnect, on a fresh transport", async () => {
    const [relayEnd, near] = MemoryTransport.pair();
    let made = 0;
    const receiver = new LSLReceiver({
      transport: () => {
        made++;
        return made === 1 ? near : MemoryTransport.pair()[1];
      },
    });

    await receiver.connect("memory://relay");
    expect(receiver.isConnected).toBe(true);
    await receiver.disconnect();
    expect(receiver.isConnected).toBe(false);
    expect(relayEnd.isOpen).toBe(false); // the first link was closed

    await receiver.connect();
    expect(receiver.isConnected).toBe(true);
    expect(made).toBe(2);
  });

  it("keeps its streams across a reconnect, and re-announcements are harmless", async () => {
    const links = [MemoryTransport.pair(), MemoryTransport.pair()];
    const receiver = new LSLReceiver({ transport: () => links.shift()![1] });
    const first = links[0][0];
    const second = links[1][0];
    const info = { eeg: { info: { name: "BioSemi", type: "EEG", channel_count: 2, source_id: "b1" } } };

    await receiver.connect("memory://relay");
    first.send(info);
    await receiver.disconnect();

    await receiver.connect();
    second.send(info); // a relay re-announces on a new connection
    receiver.startStream();

    const seen: DataPacket[] = [];
    receiver.data.subscribe((p) => seen.push(p));
    second.send({ eeg: { timeseries: [1, 2], timestamp: 1 } });

    expect(receiver.streams).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("says what is missing when there is no address", async () => {
    await expect(new LSLReceiver().connect()).rejects.toThrow(/needs the relay's address/);
  });

  it("rejects, and closes the transport, when the relay cannot be reached", async () => {
    const [, near] = MemoryTransport.pair();
    const failing = Object.create(near, {
      ready: { value: () => Promise.reject(new Error("refused")) },
    });
    const close = jest.spyOn(failing, "close");
    const receiver = new LSLReceiver({ transport: () => failing });

    await expect(receiver.connect("ws://nowhere")).rejects.toThrow("Unable to reach LSL relay.");
    expect(close).toHaveBeenCalled();
    expect(receiver.isConnected).toBe(false);
  });

  it("warns, and does nothing, when connected twice", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const receiver = await relay();
    await receiver.connect("memory://again");
    expect(warn).toHaveBeenCalledWith("LSL receiver is already connected.");
    warn.mockRestore();
  });

  it("reports the relay's stream keys, not yq-data IDs, as discovered", async () => {
    const receiver = await relay();
    send(receiver, { eeg: { info: { name: "BioSemi", type: "EEG", source_id: "b1" } } });
    expect(receiver.discoveredStreams).toEqual(["eeg"]);
    expect(receiver.streams).toEqual(["b1:eeg:raw:BioSemi"]);
  });

  it("gates samples on startStream(), and still registers streams before it", async () => {
    const [relayEnd, near] = MemoryTransport.pair();
    const receiver = new LSLReceiver({ transport: () => near });
    await receiver.connect("memory://relay");

    const seen: DataPacket[] = [];
    receiver.data.subscribe((p) => seen.push(p));
    relayEnd.send({ trials: { info: MARKER_INFO } });
    relayEnd.send({ trials: { timeseries: ["too early"], timestamp: 1 } });
    expect(receiver.streams).toHaveLength(1);
    expect(seen).toHaveLength(0);

    receiver.startStream();
    relayEnd.send({ trials: { timeseries: ["go"], timestamp: 2 } });

    // The dropped label took no code.
    expect(seen).toHaveLength(1);
    expect(seen[0].data[0]).toBe(1);
    expect(seen[0].metadata.additionalMetadata?.markerCodes).toEqual({ go: 1 });
  });
});

describe("LSL as a pipeline receive node", () => {
  it("reads a relay through a claimed transport, with a graph that is plain JSON", async () => {
    const [relayEnd, near] = MemoryTransport.pair();
    near.protocol = new LSLProtocol();

    const pipeline = new Pipeline(
      JSON.parse(
        JSON.stringify({
          nodes: [{ id: "eeg", receive: { transport: "relay" }, stream: Modality.EEG }],
          edges: [],
        })
      )
    );
    pipeline.start();
    await pipeline.attachTransport("relay", near);

    const seen: DataPacket[] = [];
    pipeline.getOutput("eeg").subscribe((p) => seen.push(p));

    relayEnd.send({
      eeg: {
        info: { name: "BioSemi", type: "EEG", channel_count: 2, nominal_srate: 256, source_id: "b1" },
      },
    });
    relayEnd.send({ eeg: { timeseries: [1, 2, 3, 4], timestamp: 5 } });

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("b1:eeg:raw:BioSemi");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
  });
});

describe("RemoteStreamReceiver with a transport factory", () => {
  it("has no transport until it connects", () => {
    const rx = new RemoteStreamReceiver(() => MemoryTransport.pair()[0]);
    expect(() => (rx as any).transport).toThrow(/no transport until connect/);
  });

  it("defaults to not trusting the remote clock, since it cannot ask the transport", async () => {
    const [far, near] = MemoryTransport.pair();
    const rx = new RemoteStreamReceiver(() => near);
    await rx.connect();
    rx.startStream();
    const seen: DataPacket[] = [];
    rx.data.subscribe((p) => seen.push(p));

    far.send({
      protocol: "yq-stream",
      v: 1,
      type: "packet",
      streamID: "x-1:eeg:raw",
      timestamp: 12345,
      channelCount: 1,
      data: [1],
    });

    expect(seen[0].timestamp).not.toBe(12345);
    expect(seen[0].deviceTime).toBe(12345);
  });
});

describe("LSLReceiver over its default WebSocket", () => {
  /** A WebSocket that opens on the next tick and is driven by the test. */
  class FakeSocket {
    static made: FakeSocket[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      FakeSocket.made.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(): void {}
    close(): void {}
  }

  const original = (globalThis as any).WebSocket;
  beforeEach(() => {
    FakeSocket.made = [];
    (globalThis as any).WebSocket = FakeSocket;
  });
  afterEach(() => {
    (globalThis as any).WebSocket = original;
  });

  it("opens the address it was given and reads JSON off the socket", async () => {
    const receiver = new LSLReceiver();
    await receiver.connect("ws://lab:8080");
    receiver.startStream();

    expect(FakeSocket.made.map((s) => s.url)).toEqual(["ws://lab:8080"]);

    const socket = FakeSocket.made[0];
    socket.onmessage?.({
      data: JSON.stringify({
        eeg: { info: { name: "BioSemi", type: "EEG", channel_count: 2, source_id: "b1" } },
      }),
    });
    const seen: DataPacket[] = [];
    receiver.data.subscribe((p) => seen.push(p));
    socket.onmessage?.({ data: JSON.stringify({ eeg: { timeseries: [1, 2], timestamp: 1 } }) });

    expect(receiver.streams).toEqual(["b1:eeg:raw:BioSemi"]);
    expect(Array.from(seen[0].data)).toEqual([1, 2]);
    await receiver.disconnect();
  });

  it("reconnects after the relay drops, with the options it was given", async () => {
    const receiver = new LSLReceiver({ reconnectDelay: 5, maxReconnectDelay: 20 });
    await receiver.connect("ws://lab:8080");
    expect(receiver.isConnected).toBe(true);

    FakeSocket.made[0].onclose?.();
    expect(receiver.isConnected).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(FakeSocket.made.length).toBeGreaterThanOrEqual(2);
    expect(receiver.isConnected).toBe(true);
    await receiver.disconnect();
  });

  it("does not reconnect when told not to", async () => {
    const receiver = new LSLReceiver({ autoReconnect: false, reconnectDelay: 5 });
    await receiver.connect("ws://lab:8080");

    FakeSocket.made[0].onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(FakeSocket.made).toHaveLength(1);
    expect(receiver.isConnected).toBe(false);
  });

  it("stops reconnecting once disconnected on purpose", async () => {
    const receiver = new LSLReceiver({ reconnectDelay: 5 });
    await receiver.connect("ws://lab:8080");
    FakeSocket.made[0].onclose?.();
    await receiver.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeSocket.made).toHaveLength(1);
  });
});
