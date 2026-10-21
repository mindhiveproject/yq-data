/**
 * Golden-value tests: camera pulse extraction (POS) and the rate it yields.
 *
 * Fixture: `rppg.json` (see `ref_rppg.py`). Three layers:
 *
 *  1. Definition -- Wang et al.'s Algorithm 1 (2017) in NumPy. The streaming
 *     PulseExtraction node, fed one frame at a time as RPPGReceiver feeds it,
 *     must reproduce it to float32 precision, and `extractPulse` to float64.
 *  2. Field toolboxes, from the authors' code -- pyVHR's `cpu_POS`, compared
 *     where its skipped first window cannot reach; rPPG-Toolbox's `POS_WANG`
 *     and FFT heart rate, compared per window at the heart-rate level.
 *  3. Ground truth -- the synthetic colour signals know their beats. Scored
 *     against the rate of the true beats in each 10 s window.
 */
import "./allclose";
import {
  DataPacket,
  HeartRate,
  Modality,
  PulseAlgorithm,
  PulseExtraction,
  StreamMetadata,
  extractPulse,
  interleave,
  nextPowerOfTwo,
  spectrum,
} from "../../../src";
import { fixture, inputs } from "./harness";

interface RppgWindow {
  start: number;
  stop: number;
  truthMedianRate: number;
  truthMeanRate: number;
  /** rPPG-Toolbox: POS_WANG over the whole signal, then _calculate_fft_hr on this window. */
  toolboxRate: number;
}

interface RppgCase {
  signal: string;
  samplingRate: number;
  windowLength: number;
  pyvhrWindowLength: number;
  toolboxWindowLength: number;
  /** Wang et al. (2017) Algorithm 1, paper sign. */
  pos: number[];
  green: number[];
  pyvhr: number[];
  toolboxBvp: number[];
  truthBeats: number[];
  windows: RppgWindow[];
}

const golden = fixture<{ cases: RppgCase[] }>("rppg");

/** Signals where colour, not sensor noise, dominates: the case POS is built for. */
const POS_PREMISE = new Set([
  "rppg_rgb_still_72bpm",
  "rppg_rgb_flicker_66bpm",
  "rppg_rgb_motion_84bpm",
]);

function cameraMeta(fs: number): StreamMetadata {
  return {
    streamID: "rppg:video:preprocessed:rppg",
    modality: Modality.VIDEO,
    samplingRate: fs,
    channelCount: 3,
    channelInfo: [
      { index: 0, label: "red" },
      { index: 1, label: "green" },
      { index: 2, label: "blue" },
    ],
    additionalMetadata: { sampleClock: true },
  };
}

/**
 * The colour signal through a PulseExtraction node, in packets of the given
 * sizes (cycled), stamped as RPPGReceiver stamps them: the time of the last
 * sample, on the sample grid.
 */
function stream(signal: string, algorithm: PulseAlgorithm, sizes: number[] = [1]): number[] {
  const sig = inputs[signal];
  const fs = sig.fs;
  const n = sig.channels[0].length;
  const data = interleave(sig.channels.map((c) => Float32Array.from(c)));
  const metadata = cameraMeta(fs);
  const node = new PulseExtraction({ algorithm });
  const out: number[] = [];
  for (let i = 0, k = 0; i < n; k++) {
    const size = Math.min(sizes[k % sizes.length], n - i);
    const packet: DataPacket = {
      streamID: metadata.streamID,
      timestamp: ((i + size - 1) * 1000) / fs,
      data: data.slice(i * 3, (i + size) * 3),
      metadata,
    };
    const result = node.analyze(packet);
    if (result) out.push(...result.data);
    i += size;
  }
  return out;
}

const negate = (x: ArrayLike<number>) => Array.from(x, (v) => -v);
const scaleOf = (x: number[]) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

function rateOf(pulse: number[], fs: number, w: RppgWindow, strategy: "peaks" | "spectral"): number {
  const packet: DataPacket = {
    streamID: "rppg:ppg:preprocessed:pulse",
    timestamp: 0,
    data: Float32Array.from(pulse.slice(w.start, w.stop)),
    metadata: {
      streamID: "rppg:ppg:preprocessed:pulse",
      modality: Modality.PPG,
      samplingRate: fs,
      channelCount: 1,
    },
  };
  return new HeartRate({ smoothing: 0, strategy }).analyze(packet)!.data[0];
}

/**
 * The step a one-sample change in the median interval makes, at a rate.
 * The `peaks` strategy measures intervals in whole samples, so at 30 fps and
 * 84 bpm (21-22 samples) it cannot resolve better than about 4 bpm.
 */
function oneSampleStep(bpm: number, fs: number): number {
  const interval = Math.round((60 * fs) / bpm);
  return (60 * fs) / interval - (60 * fs) / (interval + 1);
}

/** One FFT bin in bpm: HeartRate and rPPG-Toolbox both zero-pad to a power of two. */
const binOf = (w: RppgWindow, fs: number) => (60 * fs) / nextPowerOfTwo(w.stop - w.start);

describe("golden: PulseExtraction vs Wang et al. (2017) Algorithm 1", () => {
  it.each(golden.cases)("$signal: the streaming node, frame by frame, matches it", (c) => {
    const out = stream(c.signal, "pos");
    // A sample is emitted once the last window covering it is added, so the
    // final windowLength - 1 samples are still open at the end.
    const final = c.pos.length - c.windowLength + 1;
    expect(out).toHaveLength(final);
    // Same float32 colour on both sides, float64 arithmetic; the only
    // difference is the node's Float32Array output (~6e-8 relative).
    const scale = scaleOf(c.pos);
    expect(negate(out)).toBeAllClose(c.pos.slice(0, final), { rtol: 0, atol: 1e-6 * scale });
  });

  it.each(golden.cases)("$signal: green-only framing matches it too", (c) => {
    const out = stream(c.signal, "green");
    const final = c.green.length - c.windowLength + 1;
    expect(negate(out)).toBeAllClose(c.green.slice(0, final), {
      rtol: 0,
      atol: 1e-6 * scaleOf(c.green),
    });
  });

  it.each(golden.cases)("$signal: packet boundaries do not change the output", (c) => {
    // Packets of 1 to 7 frames, as a resampler catching up after a slow frame
    // delivers them. Overlap-add is order-exact, so bit-identical.
    expect(stream(c.signal, "pos", [3, 1, 7, 2, 5])).toEqual(stream(c.signal, "pos"));
  });

  it.each(golden.cases)("$signal: extractPulse (batch, float64) matches it", (c) => {
    const [r, g, b] = inputs[c.signal].channels.map((ch) => Float64Array.from(Float32Array.from(ch)));
    const out = extractPulse(r, g, b, c.windowLength);
    expect(Array.from(out)).toBeAllClose(c.pos, { rtol: 0, atol: 1e-12 * scaleOf(c.pos) });
  });
});

describe("golden: PulseExtraction vs pyVHR cpu_POS", () => {
  // pyVHR's loop starts at n = w, so its first window (frames 0..w-1) is
  // never added; from frame w on every sample sees the same windows as the
  // paper's. Its eps = 1e-9 in std(S2) (~1e-3 here) moves it by ~1e-6.
  it.each(golden.cases)("$signal: identical from frame w on", (c) => {
    expect(c.pyvhrWindowLength).toBe(c.windowLength);
    const out = negate(stream(c.signal, "pos"));
    const w = c.pyvhrWindowLength;
    expect(out.slice(w)).toBeAllClose(c.pyvhr.slice(w, out.length), {
      rtol: 0,
      atol: 2e-6 * scaleOf(c.pyvhr),
    });
  });
});

describe("golden: rate from the camera pulse, per 10 s window", () => {
  const windows = golden.cases.flatMap((c) => {
    const pos = stream(c.signal, "pos");
    const green = stream(c.signal, "green");
    const fs = c.samplingRate;
    return c.windows.map((w) => ({
      ...w,
      signal: c.signal,
      fs,
      posPeaks: rateOf(pos, fs, w, "peaks"),
      posSpectral: rateOf(pos, fs, w, "spectral"),
      greenPeaks: rateOf(green, fs, w, "peaks"),
      greenSpectral: rateOf(green, fs, w, "spectral"),
    }));
  });
  const premise = windows.filter((w) => POS_PREMISE.has(w.signal));
  const label = "$signal @ $start";

  it.each(premise)(`${label}: POS + peaks within one sample interval of truth`, (w) => {
    // The rate leaves HeartRate as a float32: ~1e-5 bpm of slack.
    expect(Math.abs(w.posPeaks - w.truthMedianRate)).toBeLessThanOrEqual(
      Math.max(2, oneSampleStep(w.truthMedianRate, w.fs)) + 1e-4
    );
  });

  it.each(premise)(`${label}: POS + spectral within one FFT bin of truth`, (w) => {
    expect(Math.abs(w.posSpectral - w.truthMeanRate)).toBeLessThanOrEqual(binOf(w, w.fs) + 1e-4);
  });

  // The same estimator family on the same windows: both take the largest
  // periodogram bin of a power-of-two transform, so they land on one grid.
  // The node's Hann window and the toolbox's detrend + first-order band-pass
  // shape the peak differently, which can tip it into the neighbouring bin.
  it.each(windows)(`${label}: POS + spectral within one FFT bin of rPPG-Toolbox`, (w) => {
    expect(Math.abs(w.posSpectral - w.toolboxRate)).toBeLessThanOrEqual(binOf(w, w.fs) + 1e-4);
  });

  // What POS is for. The flicker (0.85 Hz, 3x the pulse) is a brightness
  // change: it moves all three normalised channels together, so the POS
  // plane removes it, and green alone cannot.
  it.each(windows.filter((w) => w.signal === "rppg_rgb_flicker_66bpm"))(
    `${label}: under in-band flicker, green locks onto the light and POS does not`,
    (w) => {
      expect(Math.abs(w.greenPeaks - w.truthMedianRate)).toBeGreaterThan(10);
      expect(Math.abs(w.posPeaks - w.truthMedianRate)).toBeLessThanOrEqual(2);
    }
  );

  // And its price. POS mixes three channels, so it carries three channels'
  // independent sensor noise. On a still subject in steady light with a
  // noisy 15 fps camera there is nothing for it to cancel, and at 150
  // samples per 10 s window the pulse's own second harmonic can win -- for
  // the toolbox's POS on exactly the same windows (asserted above). Over the
  // whole record both still find the true rate; green does so with several
  // times the margin.
  describe("noisy 15 fps, nothing to cancel: green has the better signal-to-noise ratio", () => {
    const c = golden.cases.find((k) => k.signal === "rppg_rgb_15fps_60bpm")!;
    const fs = c.samplingRate;
    // Mean beat rate over the record, in Hz.
    const truthHz = (fs * (c.truthBeats.length - 1)) / (c.truthBeats.at(-1)! - c.truthBeats[0]);

    /** Peak power within 0.05 Hz of the true rate, over the median of 0.7-3.3 Hz. */
    function snr(pulse: number[]) {
      const spec = spectrum(pulse, { samplingRate: fs, window: "hann", scaling: "psd" });
      const band: number[] = [];
      let peak = 0;
      let peakHz = 0;
      spec.values.forEach((v, i) => {
        const f = spec.frequencies[i];
        if (f < 0.7 || f > 3.3) return;
        band.push(v);
        if (v > peak) [peak, peakHz] = [v, f];
      });
      let atTruth = 0;
      spec.values.forEach((v, i) => {
        if (Math.abs(spec.frequencies[i] - truthHz) <= 0.05) atTruth = Math.max(atTruth, v);
      });
      band.sort((a, b) => a - b);
      return { peakHz, ratio: atTruth / band[Math.floor(band.length / 2)] };
    }
    const pos = snr(stream(c.signal, "pos"));
    const green = snr(stream(c.signal, "green"));

    it("both find the true rate over the whole record", () => {
      expect(Math.abs(pos.peakHz - truthHz)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(green.peakHz - truthHz)).toBeLessThanOrEqual(0.05);
    });

    it("green's margin is at least twice POS's", () => {
      expect(green.ratio).toBeGreaterThan(2 * pos.ratio);
    });
  });
});
