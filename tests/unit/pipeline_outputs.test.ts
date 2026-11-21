/**
 * `graph.outputs`: what leaves a graph.
 *
 * Absent, every terminal node is an output, whole. Present, it names nodes —
 * terminal or not — and optionally one stream of a node that carries several.
 * `outputs`, `data` and `describe()` all follow it, so a visual, a Recorder
 * and a transmitter read the same list.
 */
import {
  AnalysisMethod,
  BaseReceiver,
  Modality,
  Pipeline,
  PipelineGraphOutput,
  Recorder,
  StreamIdentifierLiteral,
} from "../../src";

/** EEG plus an accelerometer, both named, whose packets the test writes by hand. */
class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG, Modality.ACCELEROMETER];
  deviceID = "stub-1";

  readonly eeg: StreamIdentifierLiteral;
  readonly acc: StreamIdentifierLiteral;

  constructor() {
    super();
    this.eeg = this.initializeStream({
      modality: Modality.EEG,
      name: "eeg",
      additionalMetadata: {
        samplingRate: 256,
        channelInfo: [
          { index: 0, label: "AF7" },
          { index: 1, label: "AF8" },
        ],
      },
    });
    this.acc = this.initializeStream({
      modality: Modality.ACCELEROMETER,
      name: "acc",
      additionalMetadata: { samplingRate: 52, channelInfo: [{ index: 0, label: "x" }] },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  push(id: StreamIdentifierLiteral, values: number[], timestamp = 1000): void {
    this.streamData$.get(id)!.next({
      streamID: id,
      timestamp,
      data: Float32Array.from(values),
      metadata: this.streamMeta.get(id)!,
    });
  }
}

const build = (outputs?: PipelineGraphOutput[]) =>
  new Pipeline({
    nodes: [
      { id: "dev", receiver: "dev" },
      {
        id: "norm",
        method: AnalysisMethod.NORMALIZATION,
        parameters: { mode: "fixed", min: 0, max: 4 },
      },
      { id: "out", transmit: { transport: "cloud" } },
    ],
    edges: [
      { from: ["dev"], to: ["norm"] },
      { from: ["dev"], to: ["out"] },
    ],
    ...(outputs ? { outputs } : {}),
  });

describe("graph.outputs", () => {
  it("defaults to every terminal node, leaving sinks out", () => {
    const pipeline = build();
    expect([...pipeline.outputs.keys()]).toEqual(["norm"]);
    expect(pipeline.describe().map((d) => d.nodeId)).toEqual(["norm"]);
  });

  it("names any node, terminal or not", () => {
    const pipeline = build([{ node: "dev" }, { node: "norm" }]);
    expect([...pipeline.outputs.keys()]).toEqual(["dev", "norm"]);
  });

  it("passes only the named streams of a node that carries several", () => {
    const pipeline = build([{ node: "dev", stream: "eeg" }]);
    const dev = new StubReceiver();
    pipeline.attachReceiver("dev", dev);
    pipeline.start();

    const seen: string[] = [];
    pipeline.data.subscribe((p) => seen.push(p.metadata.name!));
    dev.push(dev.eeg, [0, 4]);
    dev.push(dev.acc, [1]);

    expect(seen).toEqual(["eeg"]);
    expect(pipeline.describe()).toEqual([
      expect.objectContaining({
        nodeId: "dev",
        stream: "eeg",
        channels: [
          { index: 0, label: "AF7" },
          { index: 1, label: "AF8" },
        ],
      }),
    ]);
  });

  it("says why a declared stream is missing", () => {
    const pipeline = build([{ node: "dev", stream: "gyro" }]);
    pipeline.attachReceiver("dev", new StubReceiver());
    expect(pipeline.describe()).toEqual([
      expect.objectContaining({
        nodeId: "dev",
        channels: [],
        reason: '"dev" carries no stream named "gyro"',
      }),
    ]);
  });

  it("rejects an output that names no node, or a sink, at construction", () => {
    expect(() => build([{ node: "ghost" }])).toThrow(/not a node/);
    expect(() => build([{ node: "out" }])).toThrow(/transmit sink/);
  });

  it("is what a Recorder captures", () => {
    const pipeline = build([{ node: "dev", stream: "eeg" }, { node: "norm" }]);
    const dev = new StubReceiver();
    pipeline.attachReceiver("dev", dev);
    pipeline.start();

    const recorder = new Recorder();
    recorder.start();
    for (const output of pipeline.outputs.values()) recorder.addSource(output);
    dev.push(dev.eeg, [0, 4, 2, 2]);
    dev.push(dev.acc, [1]);
    recorder.stop();

    const samples = Object.fromEntries(recorder.summary.map((s) => [s.streamID, s.samples]));
    expect(samples).toEqual({
      "stub-1:eeg:raw:eeg": 2,
      "stub-1:eeg:preprocessed:normalized": 2,
      "stub-1:accelerometer:preprocessed:normalized": 1,
    });
  });
});
