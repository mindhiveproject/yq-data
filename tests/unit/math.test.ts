/**
 * The math nodes: `math` (between two streams, against a constant, or on one
 * stream's values) and `lag`.
 */
import {
  createAnalyzer,
  DataPacket,
  Lag,
  MathNode,
  MathOperation,
  Modality,
  StreamMetadata,
} from "../../src";

function packet(values: number[], labels: string[], unit?: string, timestamp = 1000): DataPacket {
  const metadata: StreamMetadata = {
    streamID: "dev:eeg:features:band_power",
    modality: Modality.EEG,
    samplingRate: 4,
    channelCount: labels.length,
    channelInfo: labels.map((label, index) => ({ index, label, ...(unit ? { unit } : {}) })),
  };
  return { streamID: metadata.streamID, timestamp, data: Float32Array.from(values), metadata };
}

const run = (parameters: object, a: DataPacket, b: DataPacket) =>
  new MathNode(parameters).analyze({ a, b })!;

describe("math", () => {
  const a = packet([4, 9], ["Alpha", "Beta"], "µV²");
  const b = packet([2, 3], ["Alpha", "Beta"], "µV²");

  it.each([
    ["add", [6, 12]],
    ["subtract", [2, 6]],
    ["multiply", [8, 27]],
    ["divide", [2, 3]],
    ["power", [16, 729]],
    ["minimum", [2, 3]],
    ["maximum", [4, 9]],
  ])("%s", (operation, expected) => {
    expect(Array.from(run({ operation }, a, b).data)).toEqual(expected);
  });

  it("expresses similarity as 1 - |a - b|", () => {
    const out = run(
      { operation: "subtract", absolute: true, scale: -1, offset: 1 },
      packet([0.9, 0.2], ["smile", "blink"]),
      packet([0.6, 0.2], ["smile", "blink"])
    );
    expect(Array.from(out.data).map((v) => +v.toFixed(5))).toEqual([0.7, 1]);
  });

  it("broadcasts a single channel against every channel of the other side", () => {
    const total = packet([10], ["Total"]);
    const out = run({ operation: "divide" }, packet([2, 5], ["Alpha", "Beta"]), total);
    expect(out.data[0]).toBeCloseTo(0.2);
    expect(out.data[1]).toBeCloseTo(0.5);
    expect(out.metadata.channelInfo!.map((c) => c.label)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps port a's labels, and the unit only where adding or subtracting", () => {
    expect(run({ operation: "subtract" }, a, b).metadata.channelInfo).toEqual([
      { index: 0, label: "Alpha", unit: "µV²" },
      { index: 1, label: "Beta", unit: "µV²" },
    ]);
    expect(run({ operation: "divide" }, a, b).metadata.channelInfo![0].unit).toBeUndefined();
    expect(run({}, a, b).metadata.name).toBe("math");
  });

  it("refuses an operation it does not know", () => {
    expect(() => new MathNode({ operation: "modulo" as any })).toThrow(/Unknown math operation/);
  });
});

const values = (p: DataPacket | null) => Array.from(p!.data).map((v) => +v.toFixed(5));

describe("math on one stream", () => {
  const one = (parameters: object, input: number[]) =>
    values(new MathNode(parameters).analyze({ a: packet(input, ["L", "R"]) }));

  it.each([
    ["ln", {}, [Math.E, 1], [1, 0]],
    ["log10", {}, [100, 0.1], [2, -1]],
    ["sqrt", {}, [9, 0.25], [3, 0.5]],
    ["reciprocal", {}, [4, -2], [0.25, -0.5]],
    ["round", {}, [1.4, 1.6], [1, 2]],
    ["clamp", { min: 0, max: 1 }, [-0.5, 1.5], [0, 1]],
    ["clamp", { max: 1 }, [-5, 3], [-5, 1]],
    ["multiply", { b: 0.5 }, [4, -2], [2, -1]],
    ["power", { b: 3 }, [2, -1], [8, -1]],
  ])("%s %j", (operation, extra, input, expected) => {
    expect(one({ operation, ...extra }, input)).toEqual(expected);
  });

  it("has a b port only for a two-value operation without a constant", () => {
    expect(new MathNode({ operation: "add" }).ports).toEqual(["a", "b"]);
    expect(new MathNode({ operation: "add", b: 1 }).ports).toEqual(["a"]);
    expect(new MathNode({ operation: "ln" }).ports).toEqual(["a"]);
  });

  it("keeps the unit only where the operation does", () => {
    const input = packet([1, 2], ["Alpha", "Beta"], "µV²");
    const unit = (operation: MathOperation) =>
      new MathNode({ operation }).analyze({ a: input })!.metadata.channelInfo![0].unit;
    expect(unit("clamp")).toBe("µV²");
    expect(unit("ln")).toBeUndefined();
  });

  it("declares the same output before data as it emits", () => {
    const input = packet([1, 2], ["Alpha", "Beta"], "µV²");
    const node = new MathNode({ operation: "sqrt" });
    expect(node.describeOutput({ a: input.metadata })).toEqual(
      node.analyze({ a: input })!.metadata
    );
  });

  it("expresses frontal alpha asymmetry as ln(R / L)", () => {
    const ratio = run({ operation: "divide" }, packet([4], ["F4"]), packet([2], ["F3"]));
    const out = createAnalyzer("math", { operation: "ln" }).analyze({ a: ratio } as any);
    expect((out as DataPacket).data[0]).toBeCloseTo(Math.log(4) - Math.log(2));
  });

  it("refuses a clamp whose min is above its max", () => {
    expect(() => new MathNode({ operation: "clamp", min: 2, max: 1 })).toThrow(/above its max/);
  });
});

describe("lag", () => {
  // samplingRate 4 Hz: 0.25 s per sample.
  it("starts at the first value, then covers 1 - e^(-dt/tau) of each step", () => {
    const lag = new Lag({ lagUp: 0.25, lagDown: 0.25 });
    expect(values(lag.analyze(packet([0], ["x"])))).toEqual([0]);
    expect(values(lag.analyze(packet([1], ["x"])))[0]).toBeCloseTo(1 - Math.exp(-1), 4);
  });

  it("rises and falls at their own rates", () => {
    const lag = new Lag({ lagUp: 0, lagDown: 1e6 });
    lag.analyze(packet([0], ["x"]));
    expect(values(lag.analyze(packet([1], ["x"])))).toEqual([1]);
    expect(values(lag.analyze(packet([0], ["x"])))[0]).toBeCloseTo(1, 4);
  });

  it("times a stream without a rate by its timestamps", () => {
    const lag = new Lag({ lagUp: 1, lagDown: 1 });
    const unrated = (v: number, t: number) => {
      const p = packet([v], ["x"], undefined, t);
      delete p.metadata.samplingRate;
      return p;
    };
    lag.analyze(unrated(0, 0));
    expect(lag.analyze(unrated(1, 1000))!.data[0]).toBeCloseTo(1 - Math.exp(-1), 4);
  });

  it("forgets its state on reset", () => {
    const lag = new Lag({ lagUp: 10, lagDown: 10 });
    lag.analyze(packet([0], ["x"]));
    lag.reset();
    expect(values(lag.analyze(packet([5], ["x"])))).toEqual([5]);
  });
});
