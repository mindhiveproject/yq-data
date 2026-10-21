/**
 * Structural tests for the analysis layer: channel layout and pipeline
 * construction. The numerical behaviour of each analyzer (Windowing,
 * BandPower, HeartRate, RMSAnalyzer, Correlation) is checked against
 * reference implementations in `golden/`.
 */
import {
  AnalysisMethod,
  DataPacket,
  Modality,
  Pipeline,
  ProcessingStage,
  StreamMetadata,
  getChannel,
  interleave,
  isValidStreamID,
} from "../../src";

function eegMeta(overrides: Partial<StreamMetadata> = {}): StreamMetadata {
  return {
    streamID: "test:eeg:raw",
    modality: Modality.EEG,
    samplingRate: 256,
    channelCount: 4,
    channelInfo: ["TP9", "AF7", "AF8", "TP10"].map((label, index) => ({
      index,
      label,
    })),
    ...overrides,
  };
}

function packet(data: Float32Array, metadata: StreamMetadata): DataPacket {
  return { streamID: metadata.streamID, timestamp: Date.now(), data, metadata };
}

describe("channel layout", () => {
  it("round-trips interleaved channels", () => {
    const flat = interleave([
      Float32Array.of(1, 2, 3),
      Float32Array.of(10, 20, 30),
    ]);
    expect(Array.from(flat)).toEqual([1, 10, 2, 20, 3, 30]);

    const meta = eegMeta({ channelCount: 2, channelInfo: undefined });
    expect(Array.from(getChannel(packet(flat, meta), 1))).toEqual([10, 20, 30]);
  });

  it("rejects a bare modality as a stream ID", () => {
    expect(isValidStreamID("muse:eeg:raw")).toBe(true);
    expect(isValidStreamID("muse:eeg:raw:filtered")).toBe(true);
    expect(isValidStreamID("eeg")).toBe(false);
    expect(isValidStreamID("muse:nonsense:raw")).toBe(false);
  });
});

describe("pipeline", () => {
  it("rejects a cyclic graph at construction", () => {
    expect(
      () =>
        new Pipeline({
          nodes: [
            { id: "a", method: AnalysisMethod.NORMALIZATION },
            { id: "b", method: AnalysisMethod.NORMALIZATION },
          ],
          edges: [
            { from: ["a"], to: ["b"] },
            { from: ["b"], to: ["a"] },
          ],
        })
    ).toThrow(/cycle/i);
  });

  it("rejects an unknown analysis method", () => {
    expect(
      () => new Pipeline({ nodes: [{ id: "a", method: "nope" }], edges: [] })
    ).toThrow(/No analyzer registered/);
  });

  it("names its terminal nodes", () => {
    const pipeline = new Pipeline({
      nodes: [
        { id: "eeg", receiver: "muse", stream: Modality.EEG },
        { id: "window", method: AnalysisMethod.WINDOWING },
        { id: "power", method: AnalysisMethod.BAND_POWER },
      ],
      edges: [
        { from: ["eeg"], to: ["window"] },
        { from: ["window"], to: ["power"] },
      ],
    });

    expect(pipeline.terminalNodes).toEqual(["power"]);
    expect(ProcessingStage.FEATURES).toBe("features");
  });
});
