/**
 * Numerical smoke tests for the analysis layer.
 *
 * These check that the DSP produces physically correct answers for signals
 * whose answers are known in advance, which is the property most likely to
 * break silently when the maths is refactored.
 */
import {
  AnalysisMethod,
  BandPower,
  Correlation,
  DataPacket,
  HeartRate,
  Modality,
  Pipeline,
  ProcessingStage,
  RMSAnalyzer,
  StreamMetadata,
  Windowing,
  getChannel,
  interleave,
  isValidStreamID,
} from "../../src";

const EEG_RATE = 256;

function eegMeta(overrides: Partial<StreamMetadata> = {}): StreamMetadata {
  return {
    streamID: "test:eeg:raw",
    modality: Modality.EEG,
    samplingRate: EEG_RATE,
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

/** Chunks of a sine wave, shaped the way a device delivers them. */
function* sineChunks(
  frequency: number,
  channels: number,
  rate: number,
  chunkSize: number,
  chunks: number
) {
  for (let chunk = 0; chunk < chunks; chunk++) {
    const perChannel: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const samples = new Float32Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        const t = (chunk * chunkSize + i) / rate;
        samples[i] = Math.sin(2 * Math.PI * frequency * t);
      }
      perChannel.push(samples);
    }
    yield interleave(perChannel);
  }
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

describe("windowing", () => {
  it("buffers until a full window is available, then emits every hop", () => {
    const windowing = new Windowing({ size: 2, hop: 1 });
    const meta = eegMeta();

    let emitted = 0;
    // 100 chunks x 12 samples = 1200 samples; a 512-sample window stepping
    // by 256 fits (1200 - 512) / 256 + 1 = 3 times.
    for (const chunk of sineChunks(10, 4, EEG_RATE, 12, 100)) {
      if (windowing.analyze(packet(chunk, meta))) emitted++;
    }
    expect(emitted).toBe(3);
  });
});

describe("band power", () => {
  it("puts a 10 Hz tone in the Alpha band", () => {
    const windowing = new Windowing({ size: 2, hop: 2 });
    const bandPower = new BandPower();
    const meta = eegMeta();

    let result: DataPacket | null = null;
    for (const chunk of sineChunks(10, 4, EEG_RATE, 12, 100)) {
      const windowed = windowing.analyze(packet(chunk, meta));
      if (windowed) result = bandPower.analyze(windowed) ?? result;
    }

    expect(result).not.toBeNull();
    const labels = result!.metadata.channelInfo!.map((c) => c.label);
    const values = Array.from(result!.data);
    const dominant = labels[values.indexOf(Math.max(...values))];

    expect(dominant).toBe("Alpha");
    expect(result!.streamID).toBe("test:eeg:features:band_power");
    // The tone should dominate by a wide margin, not merely edge ahead.
    const alpha = values[labels.indexOf("Alpha")];
    const theta = values[labels.indexOf("Theta")];
    expect(alpha / theta).toBeGreaterThan(20);
  });
});

describe("heart rate", () => {
  const PPG_RATE = 64;
  const ppgMeta = eegMeta({
    streamID: "test:ppg:raw",
    modality: Modality.PPG,
    samplingRate: PPG_RATE,
    channelCount: 1,
    channelInfo: [{ index: 0, label: "infrared" }],
  });

  it("recovers 72 bpm from a 1.2 Hz pulse with baseline wander", () => {
    const windowing = new Windowing({ size: 10, hop: 10 });
    const heartRate = new HeartRate({ smoothing: 0 });

    let result: DataPacket | null = null;
    for (let i = 0; i < PPG_RATE * 30; i += 4) {
      const samples = new Float32Array(4);
      for (let k = 0; k < 4; k++) {
        const t = (i + k) / PPG_RATE;
        samples[k] =
          Math.sin(2 * Math.PI * 1.2 * t) + 0.4 * Math.sin(2 * Math.PI * 0.05 * t);
      }
      const windowed = windowing.analyze(packet(samples, ppgMeta));
      if (windowed) result = heartRate.analyze(windowed) ?? result;
    }

    expect(result).not.toBeNull();
    expect(result!.data[0]).toBeGreaterThan(68);
    expect(result!.data[0]).toBeLessThan(76);
  });
});

describe("rms", () => {
  it("reports a full-scale sine at -3 dBFS", () => {
    const meta = eegMeta({
      streamID: "mic:audio:raw",
      modality: Modality.AUDIO,
      samplingRate: 48000,
      channelCount: 1,
      channelInfo: [{ index: 0, label: "mono" }],
    });

    const tone = new Float32Array(1024);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }

    const result = new RMSAnalyzer({ decibels: true }).analyze(
      packet(tone, meta)
    );
    expect(result!.data[0]).toBeCloseTo(-3.01, 1);
  });
});

describe("correlation", () => {
  it("reports 1 for signals identical up to an affine transform", () => {
    const meta = (id: string) =>
      eegMeta({
        streamID: id,
        channelCount: 1,
        channelInfo: [{ index: 0, label: "x" }],
      });

    const a = new Float32Array(256);
    const b = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      a[i] = Math.sin(i / 10);
      b[i] = Math.sin(i / 10) * 2 + 1;
    }

    const result = new Correlation({ mode: "mean" }).analyze({
      a: packet(a, meta("a:eeg:preprocessed")),
      b: packet(b, meta("b:eeg:preprocessed")),
    });

    expect(result!.data[0]).toBeCloseTo(1, 3);
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
