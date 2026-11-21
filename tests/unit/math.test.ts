/**
 * The `math` node: value-by-value arithmetic between ports `a` and `b`.
 */
import { DataPacket, MathNode, Modality, StreamMetadata } from "../../src";

function packet(values: number[], labels: string[], unit?: string): DataPacket {
  const metadata: StreamMetadata = {
    streamID: "dev:eeg:features:band_power",
    modality: Modality.EEG,
    samplingRate: 4,
    channelCount: labels.length,
    channelInfo: labels.map((label, index) => ({ index, label, ...(unit ? { unit } : {}) })),
  };
  return { streamID: metadata.streamID, timestamp: 1000, data: Float32Array.from(values), metadata };
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
