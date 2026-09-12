/**
 * `graph.record` as a passive recording selection.
 *
 * A stored `{ nodes, edges }` can also carry `record: { nodes, options }` —
 * the tap points a session was capturing. The pipeline never acts on it: it
 * stands up no `Recorder` and the named nodes stay ordinary outputs.
 * `recordTargets()` resolves the ids to observables a `Recorder` can consume,
 * and `issues()` warns — never errors — when the selection has drifted.
 */
import {
  AnalysisMethod,
  BaseReceiver,
  Modality,
  Pipeline,
  Recorder,
  StreamIdentifierLiteral,
} from "../../src";

/** A one-stream EEG receiver whose packets the test writes by hand. */
class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID = "stub-1";

  readonly streamID: StreamIdentifierLiteral;

  constructor() {
    super();
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

const build = (record?: unknown) =>
  new Pipeline({
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
      { from: ["dev"], to: ["out"] },
    ],
    ...(record ? { record } : {}),
  } as any);

describe("graph.record", () => {
  it("is absent by default: no targets, no options, no issues", () => {
    const pipeline = build();
    expect(pipeline.recordTargets().size).toBe(0);
    expect(pipeline.recordOptions).toBeUndefined();
    expect(pipeline.issues()).toEqual([]);
  });

  it("resolves named nodes to their outputs, terminal or not", () => {
    const pipeline = build({ nodes: ["dev", "norm"] });
    const dev = new StubReceiver();
    pipeline.attachReceiver("eeg", dev);
    pipeline.start();

    const targets = pipeline.recordTargets();
    expect([...targets.keys()]).toEqual(["dev", "norm"]);

    const recorder = new Recorder();
    for (const source of targets.values()) recorder.addSource(source);
    recorder.start();

    dev.push([0, 4, 2, 2]); // 2 samples/channel; norm maps to [0,1,0.5,0.5]
    recorder.stop();

    const summary = Object.fromEntries(
      recorder.summary.map((s) => [s.streamID, s.samples])
    );
    expect(summary["stub-1:eeg:raw"]).toBe(2);
    expect(summary["stub-1:eeg:preprocessed:normalized"]).toBe(2);
  });

  it("exposes the stored recorder options", () => {
    const pipeline = build({
      nodes: ["norm"],
      options: { includeTimestamps: false, maxSamplesPerStream: 500 },
    });
    expect(pipeline.recordOptions).toEqual({
      includeTimestamps: false,
      maxSamplesPerStream: 500,
    });
  });

  it("does not change what the graph runs: sink and terminals are untouched", () => {
    const pipeline = build({ nodes: ["norm"] });
    expect(pipeline.terminalNodes).toEqual(["norm"]);
    expect([...pipeline.outputs.keys()]).toEqual(["norm"]);
    expect(pipeline.describe().map((d) => d.nodeId)).toEqual(["norm"]);
  });

  it("warns — but does not error — on an id that names no node", () => {
    const pipeline = build({ nodes: ["norm", "ghost"] });

    expect(pipeline.issues()).toEqual([
      {
        nodeId: "ghost",
        severity: "warning",
        reason: 'graph.record names "ghost", which is not a node in this graph',
      },
    ]);
    expect(() => pipeline.validate()).not.toThrow();
    expect([...pipeline.recordTargets().keys()]).toEqual(["norm"]);
  });

  it("warns on an id that names a transmit sink, and leaves it out of targets", () => {
    const pipeline = build({ nodes: ["out"] });

    expect(pipeline.issues()).toEqual([
      {
        nodeId: "out",
        severity: "warning",
        reason: 'graph.record names "out", a transmit sink with no output to record',
      },
    ]);
    expect(pipeline.recordTargets().size).toBe(0);
  });

  it("feeds a Recorder that was already running before the targets attached", () => {
    const pipeline = build({ nodes: ["norm"] });
    const dev = new StubReceiver();
    pipeline.attachReceiver("eeg", dev);
    pipeline.start();

    const recorder = new Recorder();
    recorder.start(); // recording before any source is attached
    for (const source of pipeline.recordTargets().values()) {
      recorder.addSource(source);
    }

    dev.push([0, 4, 0, 4]);
    recorder.stop();

    expect(recorder.summary[0].samples).toBe(2);
  });
});
