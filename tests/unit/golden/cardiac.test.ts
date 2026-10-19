/**
 * Golden-value tests: beat detection, heart rate and HRV.
 *
 * Fixture: `cardiac.json` (see `ref_cardiac.py`). Three layers:
 *
 *  1. Definitions -- given fixed beats, rate / SDNN / RMSSD are closed-form
 *     (Task Force ESC/NASPE 1996). Reference: NeuroKit2 `hrv_time`. Exact.
 *  2. Ground truth -- the synthetic PPG/rPPG signals know where every
 *     systolic peak is. Detection is scored as in Charlton et al. (2022,
 *     Physiol Meas 43:085007): a detection within +-150 ms of a true beat is a
 *     true positive. Rates are compared to the true rate per 10 s window.
 *  3. Reference pipeline -- NeuroKit2's default PPG pipeline (Elgendi 2013)
 *     on identical input, for context.
 *
 * `[divergence]` tests use `divergence` (= `it.failing`); see README.md.
 */
import "./allclose";
import {
  HeartRate,
  Peak,
  adaptiveThresholdPeaks,
  designFilter,
  detrend,
  sosfiltfilt,
  intervalVariability,
  rateFromPeaks,
  rmssd,
} from "../../../src";
import { divergence, fixture, inputs, packetFor, recorder } from "./harness";

interface CardiacDoc {
  windowSeconds: number;
  matchToleranceSeconds: number;
  cases: {
    signal: string;
    samplingRate: number;
    truthBeats: number[];
    truthRate: number;
    definitions: { medianRate: number; sdnnMs: number; rmssdMs: number };
    neurokit: { peaks: number[] };
    windows: {
      start: number;
      stop: number;
      truthBeats: number[];
      truthMedianRate: number;
      truthMeanRate: number;
      neurokitMedianRate: number;
    }[];
  }[];
}

const golden = fixture<CardiacDoc>("cardiac");
const rec = recorder("cardiac");
afterAll(() => rec.flush());

const asPeaks = (indices: number[]): Peak[] => indices.map((index) => ({ index, value: 1 }));

/** Greedy one-to-one matching within a tolerance: sensitivity, PPV, F1. */
function score(detected: number[], truth: number[], tolerance: number) {
  const used = new Set<number>();
  let tp = 0;
  for (const t of truth) {
    let best = -1;
    let bestDistance = Infinity;
    detected.forEach((d, j) => {
      const distance = Math.abs(d - t);
      if (!used.has(j) && distance <= tolerance && distance < bestDistance) {
        best = j;
        bestDistance = distance;
      }
    });
    if (best >= 0) {
      used.add(best);
      tp++;
    }
  }
  const sensitivity = tp / truth.length;
  const ppv = detected.length ? tp / detected.length : 0;
  const f1 = sensitivity + ppv > 0 ? (2 * sensitivity * ppv) / (sensitivity + ppv) : 0;
  return { sensitivity, ppv, f1 };
}

/**
 * The beats HeartRate's `peaks` strategy finds in one window. Mirrors the
 * preprocessing in heart_rate.ts (degree-6 detrend, order-2 (4-pole) bandpass over
 * [minRate, maxRate], zero-phase) because the node does not expose its peaks.
 */
function packageBeats(x: Float32Array, fs: number, minRate = 40, maxRate = 200): Peak[] {
  const sections = designFilter({
    kind: "bandpass",
    cutoff: [minRate / 60, Math.min(maxRate / 60, fs / 2 - 0.01)],
    samplingRate: fs,
    order: 2,
  });
  const pulse = sosfiltfilt(sections, detrend(x, 6, fs));
  return adaptiveThresholdPeaks(pulse, { samplingRate: fs, refractoryPeriod: 60 / maxRate })
    .peaks;
}

const windowSignal = (signal: string, start: number, stop: number) =>
  Float32Array.from(inputs[signal].channels[0].slice(start, stop));

describe("golden: rate and HRV definitions vs NeuroKit2 hrv_time", () => {
  it.each(golden.cases)("$signal: from the true beats", (c) => {
    const peaks = asPeaks(c.truthBeats);
    const fs = c.samplingRate;
    // peakIntervals() stores intervals in a Float32Array: ~1e-7 s of a ~1 s
    // interval, i.e. ~1e-4 ms on SDNN values of 15-40 ms.
    expect([
      rateFromPeaks(peaks, fs),
      intervalVariability(peaks, fs),
      rmssd(peaks, fs),
    ]).toBeAllClose(
      [c.definitions.medianRate, c.definitions.sdnnMs, c.definitions.rmssdMs],
      { rtol: 1e-5 }
    );
  });
});

describe("golden: beat detection vs ground truth (Charlton 2022 scoring)", () => {
  const detections = golden.cases.map((c) => {
    const fs = c.samplingRate;
    const tolerance = Math.round(golden.matchToleranceSeconds * fs);
    const detected: number[] = [];
    for (const w of c.windows) {
      const beats = packageBeats(windowSignal(c.signal, w.start, w.stop), fs);
      detected.push(...beats.map((p) => p.index + w.start));
    }
    const covered = c.truthBeats.filter((t) => t < c.windows[c.windows.length - 1].stop);
    const pkg = score(detected, covered, tolerance);
    const nk = score(
      c.neurokit.peaks.filter((p) => p < c.windows[c.windows.length - 1].stop),
      covered,
      tolerance
    );
    rec.record(`detection:${c.signal}`, { detected, package: pkg, neurokit: nk });
    // Beats within the match tolerance of a window boundary have their peak at
    // or beyond the edge of what the detector sees; scored separately below.
    const inside = (t: number) =>
      c.windows.every((w) => t < w.start || t >= w.start + tolerance) &&
      c.windows.every((w) => t < w.stop - tolerance || t >= w.stop);
    const interior = score(detected, covered.filter(inside), tolerance);
    return { signal: c.signal, pkg, nk, interior };
  });

  it.each(detections)("$signal: finds every beat away from window edges (sensitivity 1)", ({ interior }) => {
    expect(interior.sensitivity).toBe(1);
  });

  // ppg_muse_110bpm_noisy has a true beat at sample 2 of its third window. It
  // used to be "found" only because the zero-phase filter's start-up transient
  // (old D6) was recorded as a beat at sample 1 -- the detector does not
  // require a local maximum (D7). With the edge transient gone the beat is
  // unresolvable by a peak detector. Divergence D7.
  divergence("[divergence] finds beats at window edges too (sensitivity 1 overall)", () => {
    expect(detections.map((d) => d.pkg.sensitivity)).toEqual(detections.map(() => 1));
  });

  it.each(detections)("$signal: F1 >= 0.9, the bar Charlton et al. use for good at rest", ({ pkg }) => {
    expect(pkg.f1).toBeGreaterThanOrEqual(0.9);
  });

  // Every false positive measured sits within 0.1 s of a window boundary. Two
  // causes: the detector records a falling edge at sample 1 as a beat (it does
  // not require a local maximum), and, before D6 was closed, the zero-phase
  // filter's edge transient added small bumps at the ends. NeuroKit2 scores PPV 1.0 on the three
  // PPG signals. Divergence D7.
  divergence("[divergence] no false beats: PPV 1 on every signal", () => {
    expect(detections.map((d) => d.pkg.ppv)).toEqual(detections.map(() => 1));
  });
});

describe("golden: HeartRate node vs the true rate, per 10 s window", () => {
  const windows = golden.cases.flatMap((c) =>
    c.windows.map((w) => ({ ...w, signal: c.signal, fs: c.samplingRate }))
  );
  const label = "$signal @ $start";

  afterAll(() => {
    const names: Record<string, string> = {
      ppg_muse_60bpm: "PPG 60",
      ppg_muse_75bpm_offset: "PPG 75",
      ppg_muse_110bpm_noisy: "PPG 110",
      rppg_camera_72bpm: "rPPG 72",
    };
    const categories = windows.map((w) => `${names[w.signal] ?? w.signal} · ${(w.start / w.fs).toFixed(0)} s`);
    const run = (w: (typeof windows)[number], parameters: object) =>
      new HeartRate({ smoothing: 0, ...parameters }).analyze(
        packetFor(w.signal, { samples: [w.start, w.stop] })
      )!.data;

    rec.compare({
      id: "heart_rate:rate",
      group: "Heart rate",
      title: "Median heart rate per 10 s window",
      note: "HeartRate (peaks strategy) against the median rate of the true beats. At 30 Hz one sample of interval is a 2.8 bpm step, so the camera signal cannot do better than that.",
      tolerance: 0.05,
      kind: "bars",
      categories,
      series: [
        { name: "Package", role: "package", values: windows.map((w) => run(w, {})[0]) },
        { name: "True beats", role: "truth", values: windows.map((w) => w.truthMedianRate) },
      ],
      yLabel: "bpm",
      expect: "match",
    });
    rec.compare({
      id: "heart_rate:sdnn",
      group: "Heart rate",
      title: "SDNN per 10 s window",
      note: "SDNN and RMSSD take every detected interval as given, so a false beat at a window edge inflates them.",
      kind: "bars",
      categories,
      series: [
        { name: "Package", role: "package", values: windows.map((w) => run(w, { includeVariability: true })[1]) },
        {
          name: "True beats",
          role: "truth",
          values: windows.map((w) => intervalVariability(asPeaks(w.truthBeats), w.fs)),
        },
      ],
      yLabel: "SDNN (ms)",
      unit: " ms",
      expect: "diverges",
    });
  });

  it.each(windows)(`${label}: peaks strategy within 2 bpm of truth`, (w) => {
    const out = new HeartRate({ smoothing: 0 }).analyze(
      packetFor(w.signal, { samples: [w.start, w.stop] })
    )!;
    rec.record(`rate:peaks:${w.signal}:${w.start}`, out.data[0]);
    // The median inter-beat interval absorbs an occasional false beat, so
    // the rate stays within 1.5 bpm of truth even where PPV < 1 (D7).
    //
    // The rate is 60 * fs / interval-in-samples, so at a low sampling rate a
    // one-sample difference in the median interval is a large step: at 30 Hz
    // and 72 bpm (25-26 samples) it is 2.77 bpm. Where the peak lands one
    // sample either side of the truth is a property of the filter's group
    // delay shape, not of rate accuracy, so the bound is 2 bpm or one sample
    // of interval, whichever is larger.
    const interval = Math.round((60 * w.fs) / w.truthMedianRate);
    const oneSample = (60 * w.fs) / (interval * (interval - 1)); // a sample shorter: the larger step
    expect(Math.abs(out.data[0] - w.truthMedianRate)).toBeLessThanOrEqual(Math.max(2, oneSample + 0.01));
  });

  it.each(windows)(`${label}: spectral strategy within half a bin of truth`, (w) => {
    const out = new HeartRate({ smoothing: 0, strategy: "spectral" }).analyze(
      packetFor(w.signal, { samples: [w.start, w.stop] })
    )!;
    rec.record(`rate:spectral:${w.signal}:${w.start}`, out.data[0]);
    // Resolution is fs / nextPow2(n): 640 samples at 64 Hz pad to 1024, a
    // 3.75 bpm bin. Half a bin of quantisation plus 0.5 bpm for the RSA-
    // modulated rate not sitting on a bin centre.
    const binBpm = (60 * w.fs) / 2 ** Math.ceil(Math.log2(w.stop - w.start));
    expect(Math.abs(out.data[0] - w.truthMeanRate)).toBeLessThanOrEqual(binBpm / 2 + 0.5);
  });

  // SDNN / RMSSD are defined on normal-to-normal intervals (Task Force 1996);
  // reference pipelines remove or correct artefactual beats first (NeuroKit2
  // `signal_fixpeaks`, Kubios, after Lipponen & Tarvainen 2019). HeartRate
  // passes every detected interval straight through, so the edge false beats
  // of D7 inflate SDNN up to 3.5x. 25% headroom covers 64 Hz timing jitter.
  // Divergence D7.
  divergence("[divergence] SDNN within 25% of the true beats' SDNN in every window", () => {
    const ratios = windows.map((w) => {
      const out = new HeartRate({ smoothing: 0, includeVariability: true }).analyze(
        packetFor(w.signal, { samples: [w.start, w.stop] })
      )!;
      const truth = intervalVariability(asPeaks(w.truthBeats), w.fs);
      rec.record(`sdnn:${w.signal}:${w.start}`, { package: out.data[1], truth });
      return out.data[1] / truth;
    });
    for (const r of ratios) expect(Math.abs(r - 1)).toBeLessThanOrEqual(0.25);
  });
});
