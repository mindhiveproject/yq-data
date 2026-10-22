/**
 * Glitch-free evaluation: a node where branches rejoin runs once per upstream
 * packet, with every input taken from the same moment.
 *
 * The canonical case is frontal alpha asymmetry — one headset, left and right
 * channels split into separate branches, rejoined at a difference node. The
 * checks read the effect where a bound visual would: in the values the join
 * emits, against a truth that is known by construction.
 */
import {
  BaseReceiver,
  DataPacket,
  Modality,
  Pipeline,
  StreamIdentifierLiteral,
} from "../../src";

class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID = "m";

  private readonly streamID: StreamIdentifierLiteral;

  constructor(channels = 2, rate = 10) {
    super();
    this.streamID = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: rate,
        channelCount: channels,
        channelInfo: Array.from({ length: channels }, (_, index) => ({
          index,
          label: index === 0 ? "L" : index === 1 ? "R" : `c${index}`,
        })),
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  send(timestamp: number, ...values: number[]): void {
    const packet: DataPacket = {
      streamID: this.streamID,
      timestamp,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(this.streamID)!,
    };
    this.streamData$.get(this.streamID)!.next(packet);
  }
}

/** Left and right channel split off one source, rejoined at `asym`. */
function asymmetry(parameters: Record<string, any> = {}) {
  const device = new StubReceiver();
  const pipeline = new Pipeline({
    nodes: [
      { id: "src", receiver: "m" },
      { id: "left", method: "channel_selection", parameters: { indices: [0] } },
      { id: "right", method: "channel_selection", parameters: { indices: [1] } },
      {
        id: "asym",
        method: "difference",
        parameters: { mode: "signed", ...parameters },
      },
    ],
    edges: [
      { from: ["src"], to: ["left"] },
      { from: ["src"], to: ["right"] },
      { from: ["left"], to: ["asym", "a"] },
      { from: ["right"], to: ["asym", "b"] },
    ],
  });

  const emitted: DataPacket[] = [];
  pipeline.getOutput("asym").subscribe((packet) => emitted.push(packet));
  pipeline.attachReceiver("m", device);
  pipeline.start();
  return { device, emitted, pipeline };
}

/** Packet k carries L = 10k and R = k, so the true asymmetry is 9k. */
function feed(device: StubReceiver, count = 4): void {
  for (let k = 1; k <= count; k++) device.send(1000 + k * 100, 10 * k, k);
}

describe("a diamond rejoining at a multi-input node", () => {
  it.each([
    ["latest", {}],
    ["nearest", { syncPolicy: "nearest" }],
    ["timestamp", { syncPolicy: "timestamp" }],
    ["timestamp with a tight tolerance", { syncPolicy: "timestamp", tolerance: 1 }],
  ])("emits once per packet, paired correctly, under %s", (_, parameters) => {
    const { device, emitted } = asymmetry(parameters);
    feed(device);

    expect(emitted.map((p) => Array.from(p.data))).toEqual([[9], [18], [27], [36]]);
    expect(emitted.map((p) => p.timestamp)).toEqual([1100, 1200, 1300, 1400]);
  });

  it("holds when the branches have different depths", () => {
    // `src -> a` directly and `src -> pass -> b`: the longer branch used to
    // arrive after the join had already fired on the shorter one.
    const device = new StubReceiver(1);
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "m" },
        { id: "pass", method: "normalization", parameters: { mode: "fixed", min: 0, max: 100 } },
        { id: "join", method: "difference", parameters: { mode: "signed" } },
      ],
      edges: [
        { from: ["src"], to: ["join", "a"] },
        { from: ["src"], to: ["pass"] },
        { from: ["pass"], to: ["join", "b"] },
      ],
    });
    const emitted: number[] = [];
    pipeline.getOutput("join").subscribe((p) => emitted.push(p.data[0]));
    pipeline.attachReceiver("m", device);
    pipeline.start();

    for (let k = 1; k <= 4; k++) device.send(1000 + k * 100, 10 * k);

    // a - b = 10k - 10k/100 = 9.9k, once per packet.
    expect(emitted).toHaveLength(4);
    expect(emitted.map((v) => Math.round(v * 10) / 10)).toEqual([9.9, 19.8, 29.7, 39.6]);
  });

  it("holds when two source nodes read the same receiver", () => {
    // Two source nodes are two branches of one diamond: the same device packet
    // reaches both, and must be evaluated as one wave.
    const device = new StubReceiver();
    const pipeline = new Pipeline({
      nodes: [
        { id: "s1", receiver: "m" },
        { id: "s2", receiver: "m" },
        { id: "left", method: "channel_selection", parameters: { indices: [0] } },
        { id: "right", method: "channel_selection", parameters: { indices: [1] } },
        { id: "asym", method: "difference", parameters: { mode: "signed" } },
      ],
      edges: [
        { from: ["s1"], to: ["left"] },
        { from: ["s2"], to: ["right"] },
        { from: ["left"], to: ["asym", "a"] },
        { from: ["right"], to: ["asym", "b"] },
      ],
    });
    const emitted: number[] = [];
    pipeline.getOutput("asym").subscribe((p) => emitted.push(p.data[0]));
    pipeline.attachReceiver("m", device);
    pipeline.start();
    feed(device);

    expect(emitted).toEqual([9, 18, 27, 36]);
  });

  it("still pairs against the latest of a branch that did not fire", () => {
    // A branch that emits less often than the other keeps its last value: the
    // `latest` policy is for mixed cadences, and waiting must not break it.
    const device = new StubReceiver(1);
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "m" },
        { id: "win", method: "windowing", parameters: { size: 2, hop: 2, unit: "samples" } },
        { id: "mean", method: "channel_selection", parameters: { indices: [0], average: true } },
        { id: "join", method: "difference", parameters: { mode: "signed" } },
      ],
      edges: [
        { from: ["src"], to: ["mean"] },
        { from: ["src"], to: ["win"] },
        { from: ["mean"], to: ["join", "a"] },
        { from: ["win"], to: ["join", "b"] },
      ],
    });
    const emitted: number[][] = [];
    pipeline.getOutput("join").subscribe((p) => emitted.push(Array.from(p.data)));
    pipeline.attachReceiver("m", device);
    pipeline.start();

    for (let k = 1; k <= 4; k++) device.send(1000 + k * 100, k);

    // Packet 1: the window is not full, and `join` has nothing yet for port b.
    // Packet 2: both branches fire in the one wave, 2 - 1.
    // Packet 3: only `mean` fires, and pairs with the window it last got, 3 - 1.
    // Packet 4: both fire again, 4 - 3.
    expect(emitted).toEqual([[1], [2], [1]]);
  });
});

describe("several packets from one node in a wave", () => {
  it("pairs each against the newest packet on the other port, in order", () => {
    // `frames: "all"` turns one packet into three one-sample windows. The
    // other port sends a single packet, so the three pair against it in turn.
    const device = new StubReceiver(1);
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "m" },
        { id: "win", method: "windowing", parameters: { size: 1, hop: 1, unit: "samples", frames: "all" } },
        { id: "join", method: "difference", parameters: { mode: "signed" } },
      ],
      edges: [
        { from: ["src"], to: ["win"] },
        { from: ["win"], to: ["join", "a"] },
        { from: ["src"], to: ["join", "b"] },
      ],
    });
    const emitted: number[] = [];
    pipeline.getOutput("join").subscribe((p) => emitted.push(p.data[0]));
    pipeline.attachReceiver("m", device);
    pipeline.start();

    // One three-sample packet: windows 1, 2, 3 against the packet's own first sample.
    device.send(1000, 1, 2, 3);

    expect(emitted).toEqual([1 - 1, 2 - 1, 3 - 1]);
  });

  it("keeps output order within a node", () => {
    const device = new StubReceiver(1);
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "m" },
        { id: "win", method: "windowing", parameters: { size: 1, hop: 1, unit: "samples", frames: "all" } },
        { id: "norm", method: "normalization", parameters: { mode: "fixed", min: 0, max: 10 } },
      ],
      edges: [
        { from: ["src"], to: ["win"] },
        { from: ["win"], to: ["norm"] },
      ],
    });
    const emitted: number[] = [];
    pipeline.getOutput("norm").subscribe((p) => emitted.push(p.data[0]));
    pipeline.attachReceiver("m", device);
    pipeline.start();

    device.send(1000, 1, 2, 3);

    expect(emitted.map((v) => Math.round(v * 10))).toEqual([1, 2, 3]);
  });
});

describe("failures and re-entrancy", () => {
  it("reports a throwing node and lets the rest of the wave finish", () => {
    const device = new StubReceiver(1);
    const errors: string[] = [];
    const pipeline = new Pipeline(
      {
        nodes: [
          { id: "src", receiver: "m" },
          { id: "bad", method: "normalization" },
          { id: "good", method: "normalization", parameters: { mode: "fixed", min: 0, max: 10 } },
        ],
        edges: [
          { from: ["src"], to: ["bad"] },
          { from: ["src"], to: ["good"] },
        ],
      },
      { onError: (_, id) => errors.push(id) }
    );
    (pipeline as any).nodes.get("bad").analyzer.analyze = () => {
      throw new Error("boom");
    };

    const good: number[] = [];
    pipeline.getOutput("good").subscribe((p) => good.push(p.data[0]));
    pipeline.attachReceiver("m", device);
    pipeline.start();

    device.send(1000, 5);
    device.send(1100, 5);

    expect(errors).toEqual(["bad", "bad"]);
    expect(good).toHaveLength(2);
  });

  it("queues a packet that arrives mid-wave instead of recursing into it", () => {
    const device = new StubReceiver(1);
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "m" },
        { id: "norm", method: "normalization", parameters: { mode: "fixed", min: 0, max: 10 } },
      ],
      edges: [{ from: ["src"], to: ["norm"] }],
    });

    const seen: number[] = [];
    let resent = false;
    pipeline.getOutput("src").subscribe((p) => {
      seen.push(p.data[0]);
      // A subscriber that reacts to a packet by sending another.
      if (!resent) {
        resent = true;
        device.send(1100, 2);
      }
    });
    const out: number[] = [];
    pipeline.getOutput("norm").subscribe((p) => out.push(Math.round(p.data[0] * 10)));
    pipeline.attachReceiver("m", device);
    pipeline.start();

    device.send(1000, 1);

    expect(seen).toEqual([1, 2]);
    // The first wave finishes before the second begins.
    expect(out).toEqual([1, 2]);
  });
});
