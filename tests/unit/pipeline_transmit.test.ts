/**
 * Transmit / remote-receive as pipeline nodes.
 *
 * A `transmit` node is a sink: it consumes an upstream node's packets and
 * ships them out a transport, exposing no output. A `receive` node is a
 * source backed by a `RemoteStreamReceiver` the pipeline owns. Both are named
 * in the stored `{ nodes, edges }` and bound to a live transport at runtime
 * with `attachTransport()`, exactly as `attachReceiver()` binds a receiver.
 *
 * MemoryTransport delivers synchronously, so once a transport is attached a
 * packet pushed into a source is observable on the far end in the same tick.
 */
import { Subject } from "rxjs";
import {
  AnalysisMethod,
  BaseReceiver,
  DataPacket,
  MemoryTransport,
  Modality,
  Pipeline,
  RemoteStreamReceiver,
  StreamIdentifierLiteral,
  StreamTransmitter,
} from "../../src";

/** A one-stream EEG receiver whose packets the test writes by hand. */
class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID: string;

  readonly streamID: StreamIdentifierLiteral;

  constructor(id = "stub-1") {
    super();
    this.deviceID = id;
    this.streamID = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: 256,
        channelCount: 2,
        channelInfo: [
          { index: 0, label: "AF7" },
          { index: 1, label: "AF8" },
        ],
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  push(values: number[], timestamp = 1000): void {
    this.streamData$.get(this.streamID)!.next({
      streamID: this.streamID,
      timestamp,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(this.streamID)!,
    });
  }
}

/** A RemoteStreamReceiver on one half of a memory link, collecting what arrives. */
async function farEnd(transport: MemoryTransport) {
  const rx = new RemoteStreamReceiver(transport, {
    closeTransportOnDisconnect: false,
  });
  await rx.connect();
  rx.startStream();
  const seen: DataPacket[] = [];
  rx.data.subscribe((p) => seen.push(p));
  return { rx, seen };
}

describe("transmit node", () => {
  it("ships an upstream node's output out over its transport", async () => {
    const [near, far] = MemoryTransport.pair();
    const { seen } = await farEnd(far);
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [{ from: ["dev"], to: ["out"] }],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.attachTransport("cloud", near);
    pipeline.start();

    dev.push([1, 2, 3, 4]);

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("stub-1:eeg:raw");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
    expect(seen[0].metadata.channelInfo?.map((c) => c.label)).toEqual([
      "AF7",
      "AF8",
    ]);
  });

  it("sits downstream of an analyzer like any other terminal", async () => {
    const [near, far] = MemoryTransport.pair();
    const { seen } = await farEnd(far);
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        {
          id: "norm",
          method: AnalysisMethod.NORMALIZATION,
          parameters: { mode: "fixed", min: 0, max: 4 },
        },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [
        { from: ["dev"], to: ["norm"] },
        { from: ["norm"], to: ["out"] },
      ],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.attachTransport("cloud", near);
    pipeline.start();

    dev.push([0, 4, 2, 2]);

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("stub-1:eeg:preprocessed:normalized");
    expect(Array.from(seen[0].data)).toEqual([0, 1, 0.5, 0.5]);
  });

  it("attaches its transport before or after start(), like a receiver", async () => {
    const [near, far] = MemoryTransport.pair();
    const { seen } = await farEnd(far);
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [{ from: ["dev"], to: ["out"] }],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.start();
    dev.push([1, 1, 1, 1]); // nothing attached yet — dropped
    expect(seen).toHaveLength(0);

    pipeline.attachTransport("cloud", near); // after start()
    dev.push([2, 2, 2, 2]);
    expect(seen).toHaveLength(1);
  });

  it("fans one processed stream out to two transports at once", async () => {
    const [nearA, farA] = MemoryTransport.pair();
    const [nearB, farB] = MemoryTransport.pair();
    const a = await farEnd(farA);
    const b = await farEnd(farB);
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "toA", transmit: { transport: "a" } },
        { id: "toB", transmit: { transport: "b" } },
      ],
      edges: [
        { from: ["dev"], to: ["toA"] },
        { from: ["dev"], to: ["toB"] },
      ],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.attachTransport("a", nearA);
    pipeline.attachTransport("b", nearB);
    pipeline.start();

    dev.push([5, 6, 7, 8]);

    expect(Array.from(a.seen[0].data)).toEqual([5, 6, 7, 8]);
    expect(Array.from(b.seen[0].data)).toEqual([5, 6, 7, 8]);
  });

  it("reports what each sink is shipping through transmitters()", async () => {
    const [near, far] = MemoryTransport.pair();
    await farEnd(far);
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "out", label: "Cloud", transmit: { transport: "cloud" } },
      ],
      edges: [{ from: ["dev"], to: ["out"] }],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.attachTransport("cloud", near);
    pipeline.start();

    dev.push([1, 2, 3, 4]); // 2 samples per channel
    dev.push([1, 2, 3, 4]);

    expect(pipeline.transmitters()).toEqual([
      {
        nodeId: "out",
        label: "Cloud",
        transport: "cloud",
        transmitting: true,
        streams: [{ streamID: "stub-1:eeg:raw", packets: 2, samples: 4 }],
      },
    ]);
  });

  it("stops sending when its transport is detached", async () => {
    const [near, far] = MemoryTransport.pair();
    const { seen } = await farEnd(far);
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [{ from: ["dev"], to: ["out"] }],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.attachTransport("cloud", near);
    pipeline.start();

    dev.push([1, 1, 1, 1]);
    expect(seen).toHaveLength(1);

    pipeline.detachTransport("cloud");
    dev.push([2, 2, 2, 2]);
    expect(seen).toHaveLength(1);
    expect(pipeline.transmitters()[0].transmitting).toBe(false);
  });
});

describe("a sink is not an output", () => {
  const build = () =>
    new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "keep", method: AnalysisMethod.NORMALIZATION },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [
        { from: ["dev"], to: ["keep"] },
        { from: ["dev"], to: ["out"] },
      ],
    });

  it("stays out of terminalNodes, outputs and describe(), though it has no outgoing edge", () => {
    const pipeline = build();
    expect(pipeline.terminalNodes).toEqual(["keep"]);
    expect([...pipeline.outputs.keys()]).toEqual(["keep"]);
    expect(pipeline.describe().map((d) => d.nodeId)).toEqual(["keep"]);
  });

  it("throws from getOutput()", () => {
    expect(() => build().getOutput("out")).toThrow(/transmit sink/);
  });
});

describe("sink validation", () => {
  it("flags an unconnected sink as an error", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [],
    });

    const issues = pipeline.issues();
    expect(issues).toEqual([
      { nodeId: "out", severity: "error", reason: "transmit node has no input" },
    ]);
    expect(() => pipeline.validate()).toThrow(/compatibility problem/);
  });

  it("accepts a marker stream a numeric analyzer would refuse", async () => {
    const [near, far] = MemoryTransport.pair();
    const { seen } = await farEnd(far);

    const markers = new BaseMarkerish();
    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "marks" },
        { id: "out", transmit: { transport: "cloud" } },
      ],
      edges: [{ from: ["dev"], to: ["out"] }],
    });
    pipeline.attachReceiver("marks", markers);
    pipeline.attachTransport("cloud", near);
    pipeline.start();

    expect(pipeline.issues()).toEqual([]); // a sink accepts anything a transport carries

    markers.fire("go");
    expect(seen).toHaveLength(1);
    expect(seen[0].labels).toEqual(["go"]);
    expect(seen[0].metadata.valueType).toBe("categorical");
  });

  it("rejects a node that is more than one kind", () => {
    expect(
      () =>
        new Pipeline({
          nodes: [
            {
              id: "x",
              method: AnalysisMethod.NORMALIZATION,
              transmit: { transport: "cloud" },
            },
          ],
          edges: [],
        })
    ).toThrow(/more than one/);
  });

  it("rejects an edge that starts at a sink", () => {
    expect(
      () =>
        new Pipeline({
          nodes: [
            { id: "dev", receiver: "eeg" },
            { id: "out", transmit: { transport: "cloud" } },
            { id: "after", method: AnalysisMethod.NORMALIZATION },
          ],
          edges: [
            { from: ["dev"], to: ["out"] },
            { from: ["out"], to: ["after"] },
          ],
        })
    ).toThrow(/no output/);
  });
});

/** A minimal categorical-stream receiver, standing in for a MarkerReceiver. */
class BaseMarkerish extends BaseReceiver {
  deviceName = "marks";
  modalities = [Modality.EVENT_MARKER];
  deviceID = "exp-1";
  private readonly streamID: StreamIdentifierLiteral;
  private code = 0;

  constructor() {
    super();
    this.streamID = this.initializeStream({
      modality: Modality.EVENT_MARKER,
      name: "event_marker",
      additionalMetadata: { valueType: "categorical", channelCount: 1 },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  fire(label: string): void {
    this.streamData$.get(this.streamID)!.next({
      streamID: this.streamID,
      timestamp: 1000,
      data: Float32Array.from([++this.code]),
      labels: [label],
      metadata: this.streamMeta.get(this.streamID)!,
    });
  }
}

describe("receive node", () => {
  it("republishes streams arriving on its transport as a source", async () => {
    const [txHalf, rxHalf] = MemoryTransport.pair();

    // The other side of the wire: a plain transmitter feeding one EEG stream.
    const out = new StreamTransmitter(txHalf);
    const source = new Subject<DataPacket>();
    out.addSource(source);
    out.start();

    const pipeline = new Pipeline({
      nodes: [
        { id: "in", receive: { transport: "down" } },
        {
          id: "norm",
          method: AnalysisMethod.NORMALIZATION,
          parameters: { mode: "fixed", min: 0, max: 10 },
        },
      ],
      edges: [{ from: ["in"], to: ["norm"] }],
    });
    pipeline.start();
    await pipeline.attachTransport("down", rxHalf);

    const seen: DataPacket[] = [];
    pipeline.getOutput("norm").subscribe((p) => seen.push(p));

    source.next({
      streamID: "muse-9:eeg:raw",
      timestamp: 2000,
      data: Float32Array.from([0, 5, 10]),
      metadata: {
        streamID: "muse-9:eeg:raw",
        modality: Modality.EEG,
        samplingRate: 256,
        channelCount: 1,
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("muse-9:eeg:preprocessed:normalized");
    expect(Array.from(seen[0].data)).toEqual([0, 0.5, 1]);
  });

  it("loops a transmit node back to a receive node in the same graph", async () => {
    const [aHalf, bHalf] = MemoryTransport.pair();
    const dev = new StubReceiver();

    const pipeline = new Pipeline({
      nodes: [
        { id: "dev", receiver: "eeg" },
        { id: "out", transmit: { transport: "up" } },
        { id: "back", receive: { transport: "down" } },
      ],
      edges: [{ from: ["dev"], to: ["out"] }],
    });
    pipeline.attachReceiver("eeg", dev);
    pipeline.start();
    pipeline.attachTransport("up", aHalf);
    await pipeline.attachTransport("down", bHalf);

    const seen: DataPacket[] = [];
    pipeline.getOutput("back").subscribe((p) => seen.push(p));

    dev.push([1, 2, 3, 4], 4242);

    expect(seen).toHaveLength(1);
    expect(seen[0].streamID).toBe("stub-1:eeg:raw");
    expect(Array.from(seen[0].data)).toEqual([1, 2, 3, 4]);
    expect(seen[0].timestamp).toBe(4242); // same-machine transport keeps the clock
  });
});
