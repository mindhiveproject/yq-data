/**
 * The math nodes: `math` between ports `a` and `b`, and `function`, `limit`
 * and `lag` on one stream's values.
 */
import {
  createAnalyzer,
  DataPacket,
  FunctionNode,
  Lag,
  Limit,
  MathNode,
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

describe("function", () => {
  it.each([
    ["abs", {}, [-2, 0.5], [2, 0.5]],
    ["ln", {}, [Math.E, 1], [1, 0]],
    ["log10", {}, [100, 0.1], [2, -1]],
    ["sqrt", {}, [9, 0.25], [3, 0.5]],
    ["power", { exponent: 3 }, [2, -1], [8, -1]],
    ["reciprocal", {}, [4, -2], [0.25, -0.5]],
    ["round", {}, [1.4, 1.6], [1, 2]],
  ])("%s", (fn, extra, input, expected) => {
    const out = new FunctionNode({ function: fn as any, ...extra }).analyze(packet(input, ["L", "R"]));
    expect(values(out)).toEqual(expected);
  });

  it("keeps the unit only where the function does", () => {
    const input = packet([1, 2], ["Alpha", "Beta"], "µV²");
    expect(new FunctionNode({ function: "abs" }).analyze(input)!.metadata.channelInfo![0]).toEqual(
      { index: 0, label: "Alpha", unit: "µV²" }
    );
    expect(new FunctionNode({ function: "ln" }).analyze(input)!.metadata.channelInfo![0]).toEqual(
      { index: 0, label: "Alpha" }
    );
  });

  it("expresses frontal alpha asymmetry as ln(R / L)", () => {
    const ratio = run({ operation: "divide" }, packet([4], ["F4"]), packet([2], ["F3"]));
    const out = createAnalyzer("function", { function: "ln" }).analyze(ratio as any);
    expect((out as DataPacket).data[0]).toBeCloseTo(Math.log(4) - Math.log(2));
  });

  it("refuses a function it does not know", () => {
    expect(() => new FunctionNode({ function: "cosh" as any })).toThrow(/Unknown function/);
  });
});

describe("limit", () => {
  it("clamps between min and max", () => {
    expect(values(new Limit({ min: 0, max: 1 }).analyze(packet([-0.5, 1.5], ["a", "b"])))).toEqual([0, 1]);
  });

  it("leaves a side without a bound alone", () => {
    expect(values(new Limit({ max: 1 }).analyze(packet([-5, 3], ["a", "b"])))).toEqual([-5, 1]);
  });

  it("refuses a min above its max", () => {
    expect(() => new Limit({ min: 2, max: 1 })).toThrow(/above its max/);
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
