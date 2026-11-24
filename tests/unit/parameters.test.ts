/**
 * Exposed parameters: method schemas, `graph.parameters`, per-instance values
 * and `setParameter()`.
 *
 * A study chooses its own window length or filter band without copying the
 * graph, so the values must reach the nodes that read them, be checked
 * against the method's range, and change live without restarting the rest of
 * the graph.
 */
import {
  AnalysisMethod,
  BaseReceiver,
  DataPacket,
  Modality,
  Pipeline,
  PipelineGraph,
  StreamIdentifierLiteral,
  Windowing,
  checkParameter,
  createAnalyzer,
  graphParameters,
  parameterSchema,
  receiverSchema,
  registerReceiver,
  registeredMethods,
  registeredReceivers,
} from "../../src";

class StubReceiver extends BaseReceiver {
  deviceName = "stub";
  modalities = [Modality.EEG];
  deviceID = "s";
  private readonly streamID: StreamIdentifierLiteral;

  constructor() {
    super();
    this.streamID = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: 10,
        channelCount: 2,
        channelInfo: [
          { index: 0, label: "x" },
          { index: 1, label: "y" },
        ],
      },
    });
    this.isConnected = true;
  }

  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

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

/** Windows of `size` samples, read from the `length` parameter. */
const graph: PipelineGraph = {
  nodes: [
    { id: "src", receiver: "s" },
    {
      id: "window",
      method: AnalysisMethod.WINDOWING,
      parameters: { unit: "samples", size: { $parameter: "length" } },
    },
  ],
  edges: [{ from: ["src"], to: ["window"] }],
  parameters: { length: { label: "Window", default: 2, min: 1, max: 10 } },
};

function run(options = {}) {
  const receiver = new StubReceiver();
  const pipeline = new Pipeline(graph, options);
  pipeline.attachReceiver("s", receiver);
  pipeline.start();
  const sizes: number[] = [];
  pipeline.getOutput("window").subscribe((p) => sizes.push(p.data.length / 2));
  return { receiver, pipeline, sizes };
}

describe("method schemas", () => {
  it("every built-in method declares one", () => {
    for (const method of registeredMethods()) {
      expect(parameterSchema(method)).toBeDefined();
    }
  });

  it("a schema's defaults are the analyzer's defaults", () => {
    const analyzer = createAnalyzer(AnalysisMethod.WINDOWING) as Windowing;
    expect((analyzer as any).parameters).toMatchObject({ size: 2, unit: "seconds" });
    // A node's own value still wins.
    const custom = createAnalyzer(AnalysisMethod.WINDOWING, { size: 5 });
    expect((custom as any).parameters.size).toBe(5);
  });

  it("checks type and range", () => {
    expect(checkParameter({ type: "number", min: 0 }, -1)).toMatch(/below the minimum/);
    expect(checkParameter({ type: "integer" }, 1.5)).toMatch(/whole number/);
    expect(checkParameter({ type: "enum", options: ["a", "b"] }, "c")).toMatch(/one of/);
    expect(checkParameter({ type: "numbers", min: 0 }, [1, 40])).toBeUndefined();
    expect(checkParameter({ type: "numbers", min: 0 }, 10)).toBeUndefined();
    expect(checkParameter({ type: "numbers", max: 30 }, [1, 40])).toMatch(/above the maximum/);
    expect(checkParameter({ type: "json" }, { anything: true })).toBeUndefined();
  });
});

describe("graphParameters", () => {
  it("fills in type and label from the method, and keeps the graph's range", () => {
    expect(graphParameters(graph).length).toEqual({
      type: "number",
      min: 1,
      max: 10,
      default: 2,
      label: "Window",
      description: expect.any(String),
    });
  });

  it("rejects a read of an undeclared parameter", () => {
    const broken = { ...graph, parameters: {} };
    expect(() => graphParameters(broken)).toThrow(/does not declare/);
    expect(() => new Pipeline(broken)).toThrow(/does not declare/);
  });
});

describe("per-instance values", () => {
  it("uses the graph default", () => {
    const { receiver, sizes, pipeline } = run();
    receiver.send(1, 0, 0, 1, 1);
    expect(sizes).toEqual([2]);
    expect(pipeline.parameters).toEqual({ length: 2 });
  });

  it("uses a study's own value", () => {
    const { receiver, sizes } = run({ parameters: { length: 3 } });
    receiver.send(1, 0, 0, 1, 1);
    receiver.send(2, 2, 2, 3, 3);
    expect(sizes).toEqual([3]);
  });

  it("ignores names the graph no longer declares, and refuses values out of range", () => {
    expect(() => new Pipeline(graph, { parameters: { removed: 1 } })).not.toThrow();
    expect(() => new Pipeline(graph, { parameters: { length: 20 } })).toThrow(
      /Parameter "length": 20 is above the maximum of 10/
    );
  });

  it("falls back to the method default when nothing gives one", () => {
    const open: PipelineGraph = {
      ...graph,
      parameters: { length: {} },
      nodes: [graph.nodes[0], { ...graph.nodes[1], parameters: { size: { $parameter: "length" } } }],
    };
    const pipeline = new Pipeline(open);
    expect(pipeline.parameters).toEqual({ length: 2 });
  });
});

describe("setParameter", () => {
  it("changes the node live and restarts its window", () => {
    const { receiver, sizes, pipeline } = run();
    receiver.send(1, 0, 0, 1, 1);
    pipeline.setParameter("length", 4);
    receiver.send(2, 2, 2, 3, 3);
    expect(sizes).toEqual([2]); // the new 4-sample window is half full
    receiver.send(3, 4, 4, 5, 5);
    expect(sizes).toEqual([2, 4]);
  });

  it("describe() follows the new value", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "s" },
        {
          id: "pick",
          method: AnalysisMethod.CHANNEL_SELECTION,
          parameters: { indices: { $parameter: "channels" } },
        },
      ],
      edges: [{ from: ["src"], to: ["pick"] }],
      parameters: { channels: { default: [0] } },
    });
    pipeline.attachReceiver("s", new StubReceiver());
    expect(pipeline.describe()[0].channels.map((c) => c.label)).toEqual(["x"]);
    pipeline.setParameter("channels", [1, 0]);
    expect(pipeline.describe()[0].channels.map((c) => c.label)).toEqual(["y", "x"]);
  });

  it("undefined restores the default", () => {
    const { pipeline } = run({ parameters: { length: 5 } });
    pipeline.setParameter("length", undefined);
    expect(pipeline.parameters).toEqual({ length: 2 });
  });

  it("refuses unknown names and bad values, and changes nothing", () => {
    const { pipeline } = run();
    expect(() => pipeline.setParameter("nope", 1)).toThrow(/no parameter "nope".*length/);
    expect(() => pipeline.setParameter("length", 0)).toThrow(/below the minimum/);
    expect(() => pipeline.setParameter("length", "big")).toThrow(/expected a number/);
    expect(pipeline.parameters).toEqual({ length: 2 });
  });

  it("checks against every node that reads the parameter", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "src", receiver: "s" },
        { id: "w", method: AnalysisMethod.WINDOWING, parameters: { size: { $parameter: "n" } } },
        { id: "f", method: AnalysisMethod.FILTERING, parameters: { order: { $parameter: "n" } } },
      ],
      edges: [
        { from: ["src"], to: ["w"] },
        { from: ["src"], to: ["f"] },
      ],
      parameters: { n: { default: 4 } },
    });
    // A number for the window, but the filter's order must be whole.
    expect(() => pipeline.setParameter("n", 2.5)).toThrow(/whole number/);
  });
});

describe("receivers in the graph", () => {
  /** A stub registered as a device, counting connects, so reopening shows. */
  const built: StubReceiver[] = [];
  beforeAll(() => {
    registerReceiver(
      "stub",
      (o) => {
        const r = new StubReceiver();
        (r as any).options = o;
        r.setConnected(false);
        r.connect = jest.fn(() => r.setConnected(true));
        r.disconnect = jest.fn(() => r.setConnected(false));
        built.push(r);
        return r;
      },
      { gain: { type: "number", min: 0, max: 10, default: 1 } }
    );
  });
  beforeEach(() => (built.length = 0));

  const deviceGraph: PipelineGraph = {
    nodes: [{ id: "src", receiver: "s" }],
    edges: [],
    receivers: { s: { device: "stub", options: { gain: { $parameter: "gain" } } } },
    parameters: { gain: { default: 2 } },
  };

  it("describes its outputs with nothing attached by hand", () => {
    const pipeline = new Pipeline({
      nodes: [{ id: "body", receiver: "camera" }],
      edges: [],
      receivers: { camera: { device: "pose" } },
    });
    expect(pipeline.describe()[0].channels).toHaveLength(99);
  });

  it("builds the receiver with its parameters and the app's options", () => {
    const pipeline = new Pipeline(deviceGraph, {
      parameters: { gain: 3 },
      receiverOptions: { s: { videoElement: "el" } },
    });
    expect(pipeline.getReceiver("s")).toBe(built[0]);
    expect((built[0] as any).options).toEqual({ gain: 3, videoElement: "el" });
    expect(graphParameters(deviceGraph).gain).toMatchObject({ type: "number", max: 10 });
  });

  it("checks receiver parameters against the receiver's schema", () => {
    expect(() => new Pipeline(deviceGraph, { parameters: { gain: 11 } })).toThrow(/maximum of 10/);
  });

  it("setParameter rebuilds the receiver and reopens a connected one", async () => {
    const pipeline = new Pipeline(deviceGraph);
    pipeline.start();
    const out: number[] = [];
    pipeline.getOutput("src").subscribe((p) => out.push(p.data[0]));

    await pipeline.getReceiver("s")!.connect();
    pipeline.setParameter("gain", 5);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [old, fresh] = built;
    expect(old.disconnect).toHaveBeenCalled();
    expect(fresh.connect).toHaveBeenCalled();
    expect((fresh as any).options.gain).toBe(5);
    expect(pipeline.getReceiver("s")).toBe(fresh);

    fresh.send(1, 7, 7);
    old.send(2, 9, 9);
    expect(out).toEqual([7]); // only the new receiver feeds the graph
  });

  it("leaves a receiver attached by hand alone", () => {
    const pipeline = new Pipeline(deviceGraph);
    const mine = new StubReceiver();
    pipeline.attachReceiver("s", mine);
    pipeline.setParameter("gain", 4);
    expect(pipeline.getReceiver("s")).toBe(mine);
    expect(built).toHaveLength(1);
  });

  it("every built-in receiver type declares a schema", () => {
    for (const type of registeredReceivers().filter((t) => t !== "stub")) {
      expect(receiverSchema(type)).toBeDefined();
    }
  });
});
