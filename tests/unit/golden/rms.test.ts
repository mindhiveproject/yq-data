/**
 * Golden-value test: RMS against NumPy.
 *
 * Fixtures are produced by `generate.py` (see README.md). `_inputs.json` holds
 * the signals; `rms.json` holds the RMS NumPy computed for each. This test
 * rebuilds the analyzer's view of those signals and checks both layers:
 *
 *   - `rms()` -- the pure primitive, over float64 samples. The only thing that
 *     can differ from NumPy is summation order, so the tolerance is tight.
 *   - `RMSAnalyzer` -- the packet node. The pipeline hands it a `Float32Array`
 *     and its output is a `Float32Array`, so the reference is RMS-over-
 *     float32-rounded-input and the tolerance is float32 machine epsilon.
 *
 * This is the first slice of the golden-value suite; every method added later
 * follows the same shape (fixture + describe.each + a tolerance with a reason).
 */
import { readFileSync } from "fs";
import { join } from "path";
import "./allclose";
import {
  DataPacket,
  Modality,
  RMSAnalyzer,
  StreamMetadata,
  interleave,
  rms,
} from "../../../src";

interface InputsDoc {
  signals: Record<
    string,
    { description: string; fs: number; channels: number[][] }
  >;
}

interface RmsDoc {
  generatedBy: Record<string, string>;
  reference: string;
  cases: {
    signal: string;
    expected: number[];
    expectedFromFloat32: number[];
    expectedDbfs: number[];
  }[];
}

const DIR = join(__dirname, "fixtures");
const inputs: InputsDoc = JSON.parse(
  readFileSync(join(DIR, "_inputs.json"), "utf8")
);
const golden: RmsDoc = JSON.parse(readFileSync(join(DIR, "rms.json"), "utf8"));

function packetFor(signalName: string): DataPacket {
  const sig = inputs.signals[signalName];
  const channels = sig.channels.map((c) => Float32Array.from(c));
  const metadata: StreamMetadata = {
    streamID: "golden:eeg:raw",
    modality: Modality.EEG,
    samplingRate: sig.fs,
    channelCount: channels.length,
    channelInfo: channels.map((_, index) => ({ index, label: `ch${index}` })),
  };
  return {
    streamID: metadata.streamID,
    timestamp: 0,
    data: interleave(channels),
    metadata,
  };
}

describe("golden: RMS vs NumPy", () => {
  it("fixtures carry a recorded toolchain", () => {
    expect(golden.generatedBy.numpy).toMatch(/^\d+\.\d+/);
    expect(golden.generatedBy.python).toMatch(/^\d+\.\d+/);
  });

  describe.each(golden.cases)("$signal", (testCase) => {
    const sig = inputs.signals[testCase.signal];

    it("pure rms() matches NumPy over float64 samples", () => {
      const actual = sig.channels.map((channel) => rms(channel));
      expect(actual).toBeAllClose(testCase.expected, { rtol: 1e-11 });
    });

    it("RMSAnalyzer matches NumPy over the float32 signal it receives", () => {
      const result = new RMSAnalyzer().analyze(packetFor(testCase.signal));
      expect(result).not.toBeNull();
      // rtol 1e-6: the output is a Float32Array, so ~6 significant digits is
      // the most this comparison can ever assert.
      expect(Array.from(result!.data)).toBeAllClose(
        testCase.expectedFromFloat32,
        { rtol: 1e-6 }
      );
    });

    it("RMSAnalyzer dBFS mode matches 20*log10(rms)", () => {
      const result = new RMSAnalyzer({ decibels: true }).analyze(
        packetFor(testCase.signal)
      );
      expect(result).not.toBeNull();
      expect(Array.from(result!.data)).toBeAllClose(testCase.expectedDbfs, {
        rtol: 1e-6,
        atol: 1e-4,
      });
    });
  });
});
