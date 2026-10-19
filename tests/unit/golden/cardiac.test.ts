/**
 * Golden-value tests: beat detection, heart rate and HRV.
 *
 * Fixture: `cardiac.json` (see `ref_cardiac.py`). Four layers:
 *
 *  1. Definitions -- given fixed beats, rate / SDNN / RMSSD are closed-form
 *     (Task Force ESC/NASPE 1996). Reference: NeuroKit2 `hrv_time`. Exact.
 *  2. Conformance -- `msptdFast` is a port of the ppg-beats toolbox's
 *     MSPTDfast v2 (Charlton et al. 2025). Run on the same input, the MATLAB
 *     original (under GNU Octave) and the port must find the same samples.
 *  3. Ground truth -- the synthetic PPG/rPPG signals know where every
 *     systolic peak is; the real recording is labelled from its simultaneous
 *     ECG. Detection is scored as in Charlton et al. (2022, Physiol Meas
 *     43:085007): a detection within +-150 ms of a reference beat is a true
 *     positive. The two detectors that paper found best, MSPTD(fast) and
 *     qppg(fast), run from the authors' MATLAB on the node's own preprocessed
 *     input, are scored alongside the package.
 *  4. Reference pipeline -- NeuroKit2's default PPG pipeline (Elgendi 2013)
 *     on the whole signal, for context.
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
  ensureTroughBetweenPeaks,
  intervalVariability,
  msptdFast,
  rateFromPeaks,
  rmssd,
  sosfiltfilt,
} from "../../../src";
import { fixture, inputs, packetFor, recorder } from "./harness";

interface CardiacWindow {
  start: number;
  stop: number;
  truthMedianRate: number;
  truthMeanRate: number;
  /** Synthetic signals: the true systolic peaks, relative to `start`. */
  truthBeats?: number[];
  /** Real signal: the ECG reference is doubtful here, so it is not scored. */
  excluded?: boolean;
  /** Detections relative to `start`. All but `msptdfastRaw` ran on the node's preprocessed pulse. */
  references: {
    msptdfastRaw: number[];
    msptdfast: number[];
    msptdfastOnsets: number[];
    qppgfast: number[];
    neurokitMsptdfast: number[] | { error: string };
  };
}

interface CardiacCase {
  signal: string;
  samplingRate: number;
  real: boolean;
  /** Synthetic: true systolic peaks. */
  truthBeats?: number[];
  /** Real: ECG R peaks, as sample indices at `samplingRate`. */
  ecgBeats?: number[];
  definitions?: { medianRate: number; sdnnMs: number; rmssdMs: number };
  neurokit: { peaks: number[] };
  windows: CardiacWindow[];
}

interface CardiacDoc {
  windowSeconds: number;
  matchToleranceSeconds: number;
  cases: CardiacCase[];
}

const golden = fixture<CardiacDoc>("cardiac");
const rec = recorder("cardiac");
afterAll(() => rec.flush());

const MIN_RATE = 40;
const MAX_RATE = 200;

const asPeaks = (indices: number[]): Peak[] => indices.map((index) => ({ index, value: 1 }));
const indicesOf = (peaks: Peak[]) => peaks.map((p) => p.index);

const windowSignal = (signal: string, start: number, stop: number) =>
  Float32Array.from(inputs[signal].channels[0].slice(start, stop));

/**
 * The HeartRate node's preprocessing (degree-6 detrend, order-2 (4-pole)
 * band-pass over [minRate, maxRate], zero-phase), which the node does not
 * expose. ref_cardiac.py `package_pulse` is the same thing in Python.
 */
function pulseOf(x: Float32Array, fs: number): Float32Array {
  const sections = designFilter({
    kind: "bandpass",
    cutoff: [MIN_RATE / 60, Math.min(MAX_RATE / 60, fs / 2 - 0.01)],
    samplingRate: fs,
    order: 2,
  });
  return sosfiltfilt(sections, detrend(x, 6, fs));
}

/** The beats the node's `peaks` strategy uses, per detector. */
const detectors = {
  msptdfast: (pulse: Float32Array, fs: number) =>
    indicesOf(ensureTroughBetweenPeaks(pulse, msptdFast(pulse, fs).peaks)),
  adaptiveThreshold: (pulse: Float32Array, fs: number) =>
    indicesOf(
      adaptiveThresholdPeaks(pulse, { samplingRate: fs, refractoryPeriod: 60 / MAX_RATE }).peaks
    ),
};

/** Greedy one-to-one matching within a tolerance: true positives. */
function matches(detected: number[], truth: number[], tolerance: number): number {
  const used = new Uint8Array(detected.length);
  let tp = 0;
  for (const t of truth) {
    let best = -1;
    let bestDistance = Infinity;
    for (let j = 0; j < detected.length; j++) {
      const distance = Math.abs(detected[j] - t);
      if (!used[j] && distance <= tolerance && distance < bestDistance) {
        best = j;
        bestDistance = distance;
      }
    }
    if (best >= 0) {
      used[best] = 1;
      tp++;
    }
  }
  return tp;
}

interface Score {
  sensitivity: number;
  ppv: number;
  f1: number;
}

function score(detected: number[], truth: number[], tolerance: number): Score {
  const tp = matches(detected, truth, tolerance);
  const sensitivity = truth.length ? tp / truth.length : 1;
  const ppv = detected.length ? tp / detected.length : 0;
  const f1 = sensitivity + ppv > 0 ? (2 * sensitivity * ppv) / (sensitivity + ppv) : 0;
  return { sensitivity, ppv, f1 };
}

const scoredWindows = (c: CardiacCase) => c.windows.filter((w) => !w.excluded);
const inScored = (c: CardiacCase, i: number) =>
  scoredWindows(c).some((w) => i >= w.start && i < w.stop);

/**
 * Reference beats for scoring, in the scored windows.
 *
 * Synthetic: the true systolic peaks. Real: the ECG R peaks, shifted by the
 * pulse arrival time. As in the ppg-beats toolbox (`align_ppg_ecg_beats.m`)
 * the shift is the one that lets the most R peaks find a detection, searched
 * in 20 ms steps -- here over 0-1 s, since the pulse follows the R peak --
 * taking the smallest shift on a tie.
 */
function referenceFor(c: CardiacCase, detected: number[], tolerance: number): number[] {
  if (!c.real) return c.truthBeats!.filter((t) => inScored(c, t));
  const fs = c.samplingRate;
  let best = { count: -1, shifted: [] as number[] };
  for (let lag = 0; lag < 1; lag += 0.02) {
    const shifted = c.ecgBeats!.map((r) => r + Math.round(lag * fs)).filter((t) => inScored(c, t));
    const count = matches(detected, shifted, tolerance);
    if (count > best.count) best = { count, shifted };
  }
  return best.shifted;
}

/** Every detector's beats over a signal's scored windows, as global indices. */
function detectionsFor(c: CardiacCase): Record<string, number[]> {
  const fs = c.samplingRate;
  const out: Record<string, number[]> = {
    package: [],
    shin: [],
    msptdfastMatlab: [],
    qppgfastMatlab: [],
    msptdfastNeurokit: [],
  };
  for (const w of scoredWindows(c)) {
    const pulse = pulseOf(windowSignal(c.signal, w.start, w.stop), fs);
    const shift = (xs: number[]) => xs.map((i) => i + w.start);
    out.package.push(...shift(detectors.msptdfast(pulse, fs)));
    out.shin.push(...shift(detectors.adaptiveThreshold(pulse, fs)));
    out.msptdfastMatlab.push(...shift(w.references.msptdfast));
    out.qppgfastMatlab.push(...shift(w.references.qppgfast));
    const nk = w.references.neurokitMsptdfast;
    if (Array.isArray(nk)) out.msptdfastNeurokit.push(...shift(nk));
  }
  out.elgendiNeurokit = c.neurokit.peaks.filter((p) => inScored(c, p));
  return out;
}

const LABELS: Record<string, string> = {
  ppg_muse_60bpm: "PPG 60",
  ppg_muse_75bpm_offset: "PPG 75",
  ppg_muse_110bpm_noisy: "PPG 110",
  rppg_camera_72bpm: "rPPG 72",
  ppg_real_rest_100hz: "Real 100 Hz",
  ppg_real_rest_64hz: "Real 64 Hz",
};

describe("golden: rate and HRV definitions vs NeuroKit2 hrv_time", () => {
  it.each(golden.cases.filter((c) => c.definitions))("$signal: from the true beats", (c) => {
    const peaks = asPeaks(c.truthBeats!);
    const fs = c.samplingRate;
    // peakIntervals() stores intervals in a Float32Array: ~1e-7 s of a ~1 s
    // interval, i.e. ~1e-4 ms on SDNN values of 15-40 ms.
    expect([
      rateFromPeaks(peaks, fs),
      intervalVariability(peaks, fs),
      rmssd(peaks, fs),
    ]).toBeAllClose(
      [c.definitions!.medianRate, c.definitions!.sdnnMs, c.definitions!.rmssdMs],
      { rtol: 1e-5 }
    );
  });
});

describe("golden: msptdFast vs the MATLAB original (ppg-beats msptdfastv2_beat_detector)", () => {
  // Same float32 input on both sides, so the scalogram comparisons are the
  // same comparisons and the result must agree to the sample.
  it.each(golden.cases)("$signal: same peaks on the raw window, every window", (c) => {
    for (const w of c.windows) {
      const found = indicesOf(msptdFast(windowSignal(c.signal, w.start, w.stop), c.samplingRate).peaks);
      expect({ start: w.start, peaks: found }).toEqual({ start: w.start, peaks: w.references.msptdfastRaw });
    }
  });

  // The preprocessed pulse is computed on each side (TypeScript here, SciPy
  // in the fixture) and agrees to float32 rounding. Agreement to the sample
  // then says the preprocessing matches too.
  it.each(golden.cases)("$signal: same peaks and onsets on the node's preprocessed pulse", (c) => {
    for (const w of c.windows) {
      const beats = msptdFast(pulseOf(windowSignal(c.signal, w.start, w.stop), c.samplingRate), c.samplingRate);
      expect({ start: w.start, peaks: indicesOf(beats.peaks), onsets: indicesOf(beats.onsets) }).toEqual({
        start: w.start,
        peaks: w.references.msptdfast,
        onsets: w.references.msptdfastOnsets,
      });
    }
  });
});

describe("golden: beat detection vs ground truth (Charlton 2022 scoring)", () => {
  const results = golden.cases.map((c) => {
    const tolerance = Math.round(golden.matchToleranceSeconds * c.samplingRate);
    const detected = detectionsFor(c);
    const scores: Record<string, Score> = {};
    for (const [name, beats] of Object.entries(detected)) {
      scores[name] = score(beats, referenceFor(c, beats, tolerance), tolerance);
    }
    rec.record(`detection:${c.signal}`, { scores });
    return { c, tolerance, detected, scores };
  });

  afterAll(() => {
    const series = (name: string, key: string, role: "package" | "field" | "reference") => ({
      name,
      role,
      values: results.map((r) => r.scores[key].f1),
    });
    rec.compare({
      id: "heart_rate:detection_f1",
      group: "Heart rate",
      title: "Beat detection F1 per signal, 10 s windows",
      note: "F1 against the true beats (synthetic) or the ECG (real), counting a detection within 150 ms. MSPTDfast and qppgfast are the ppg-beats MATLAB run on the node's own preprocessed windows; Elgendi is NeuroKit2's default pipeline on the whole signal.",
      kind: "bars",
      categories: results.map((r) => LABELS[r.c.signal] ?? r.c.signal),
      series: [
        series("Package (MSPTDfast)", "package", "package"),
        series("MSPTDfast (MATLAB)", "msptdfastMatlab", "reference"),
        series("qppgfast (MATLAB)", "qppgfastMatlab", "reference"),
        series("MSPTDfast (NeuroKit2)", "msptdfastNeurokit", "field"),
        series("Elgendi (NeuroKit2)", "elgendiNeurokit", "field"),
        series("Shin 2009 (previous)", "shin", "field"),
      ],
      yLabel: "F1",
      yDomain: [0.8, 1],
      tolerance: 0.1,
      expect: "match",
    });
  });

  it.each(results)("$c.signal: F1 >= 0.9, the bar Charlton et al. use for good at rest", ({ scores }) => {
    expect(scores.package.f1).toBeGreaterThanOrEqual(0.9);
  });

  // The package runs the same MSPTDfast, then drops duplicate detections of a
  // beat seen from two overlapping 6 s sub-windows (ensureTroughBetweenPeaks).
  // That can only remove false positives, so F1 never falls below MATLAB's.
  it.each(results)("$c.signal: F1 at least that of the MATLAB MSPTDfast on the same input", ({ scores }) => {
    expect(scores.package.f1).toBeGreaterThanOrEqual(scores.msptdfastMatlab.f1 - 1e-12);
  });

  // D7, closed: the adaptive-threshold detector recorded falling edges at
  // window starts as beats. MSPTDfast reports a sample only when it is a
  // maximum at every scale up to the dominant one, which a window edge
  // cannot be.
  it.each(results.filter((r) => !r.c.real))("$c.signal: no false beats (PPV 1)", ({ scores }) => {
    expect(scores.package.ppv).toBe(1);
  });

  // MSPTD needs a peak to dominate the half beat either side of it, so a beat
  // closer than that to a window edge cannot be found. Every other one must.
  it.each(results.filter((r) => !r.c.real))(
    "$c.signal: finds every beat more than one inter-beat interval from a window edge",
    ({ c, tolerance, detected }) => {
      const fs = c.samplingRate;
      for (const w of c.windows) {
        const interval = Math.round((60 * fs) / w.truthMedianRate);
        const interior = w
          .truthBeats!.filter((t) => t >= interval && t < w.stop - w.start - interval)
          .map((t) => t + w.start);
        const inWindow = detected.package.filter((d) => d >= w.start && d < w.stop);
        expect({ start: w.start, sensitivity: score(inWindow, interior, tolerance).sensitivity }).toEqual({
          start: w.start,
          sensitivity: 1,
        });
      }
    }
  );
});

describe("golden: HeartRate node vs the true rate, per 10 s window", () => {
  const windows = golden.cases.flatMap((c) =>
    scoredWindows(c).map((w) => ({ ...w, signal: c.signal, fs: c.samplingRate, real: c.real }))
  );
  const synthetic = windows.filter((w) => !w.real);
  const real = windows.filter((w) => w.real);
  const label = "$signal @ $start";
  const run = (w: (typeof windows)[number], parameters: object = {}) =>
    new HeartRate({ smoothing: 0, ...parameters }).analyze(
      packetFor(w.signal, { samples: [w.start, w.stop] })
    )!.data;

  afterAll(() => {
    const categories = synthetic.map(
      (w) => `${LABELS[w.signal] ?? w.signal} · ${(w.start / w.fs).toFixed(0)} s`
    );
    rec.compare({
      id: "heart_rate:rate",
      group: "Heart rate",
      title: "Median heart rate per 10 s window, synthetic signals",
      note: "HeartRate (peaks strategy) against the median rate of the true beats. At 30 Hz one sample of interval is a 2.8 bpm step, so the camera signal cannot do better than that.",
      tolerance: 0.05,
      kind: "bars",
      categories,
      series: [
        { name: "Package", role: "package", values: synthetic.map((w) => run(w)[0]) },
        { name: "True beats", role: "truth", values: synthetic.map((w) => w.truthMedianRate) },
      ],
      yLabel: "bpm",
      expect: "match",
    });
    const fromBeats = (w: (typeof windows)[number], beats: number[]) =>
      rateFromPeaks(asPeaks(beats), w.fs, { minRate: MIN_RATE, maxRate: MAX_RATE });
    for (const signal of new Set(real.map((w) => w.signal))) {
      const ws = real.filter((w) => w.signal === signal);
      rec.compare({
        id: `heart_rate:rate:${signal}`,
        group: "Heart rate",
        title: `Median heart rate per 10 s window, ${LABELS[signal] ?? signal} real PPG`,
        note: "HeartRate against the ECG's median rate in the same window, with the two best detectors of Charlton et al. (2022) run on the node's preprocessed windows. Windows where the ECG reference itself is doubtful are left out.",
        kind: "line",
        x: ws.map((w) => w.start / w.fs),
        series: [
          { name: "Package", role: "package", values: ws.map((w) => run(w)[0]) },
          { name: "MSPTDfast (MATLAB)", role: "reference", values: ws.map((w) => fromBeats(w, w.references.msptdfast)) },
          { name: "qppgfast (MATLAB)", role: "reference", values: ws.map((w) => fromBeats(w, w.references.qppgfast)) },
          { name: "ECG", role: "truth", values: ws.map((w) => w.truthMedianRate) },
        ],
        xLabel: "window start (s)",
        yLabel: "bpm",
        tolerance: 0.05,
        expect: "match",
      });
    }
    rec.compare({
      id: "heart_rate:sdnn",
      group: "Heart rate",
      title: "SDNN per 10 s window, synthetic signals",
      note: "SDNN takes every detected interval as given, so a false beat inflates it; a beat missed at a window edge only shortens the series. The camera signal at 30 Hz is the outlier: all its intervals are true intervals, but under heavy noise a peak lands a sample (33 ms) either side of the truth, which on a 31 ms SDNN doubles it. The test's bar there is one sample period.",
      kind: "bars",
      categories,
      series: [
        { name: "Package", role: "package", values: synthetic.map((w) => run(w, { includeVariability: true })[1]) },
        {
          name: "Shin 2009 (previous)",
          role: "field",
          values: synthetic.map((w) => run(w, { includeVariability: true, detector: "adaptive-threshold" })[1]),
        },
        {
          name: "True beats",
          role: "truth",
          values: synthetic.map((w) => intervalVariability(asPeaks(w.truthBeats!), w.fs)),
        },
      ],
      yLabel: "SDNN (ms)",
      unit: " ms",
      // 25% at 64 Hz; the 30 Hz camera window reaches 0.68 of the range (see note).
      tolerance: 0.7,
      expect: "match",
    });
  });

  it.each(synthetic)(`${label}: peaks strategy within 2 bpm of truth`, (w) => {
    const rate = run(w)[0];
    rec.record(`rate:peaks:${w.signal}:${w.start}`, rate);
    // The rate is 60 * fs / interval-in-samples, so at a low sampling rate a
    // one-sample difference in the median interval is a large step: at 30 Hz
    // and 72 bpm (25-26 samples) it is 2.77 bpm. Where the peak lands one
    // sample either side of the truth is a property of the filter's group
    // delay shape, not of rate accuracy, so the bound is 2 bpm or one sample
    // of interval, whichever is larger.
    const interval = Math.round((60 * w.fs) / w.truthMedianRate);
    const oneSample = (60 * w.fs) / (interval * (interval - 1)); // a sample shorter: the larger step
    expect(Math.abs(rate - w.truthMedianRate)).toBeLessThanOrEqual(Math.max(2, oneSample + 0.01));
  });

  // Real PPG against ECG. Charlton et al. (2022) call a detector acceptable
  // for heart rate when its mean absolute percentage error is under 10%.
  // Per window the bar is 5%. The largest error, 4.2% at 64 Hz, 280 s, is
  // not a detection error: every detected interval matches its ECG interval
  // to one sample. The window ends on two short intervals, which the ECG
  // counts and MSPTDfast cannot (edge beats). Under strong sinus arrhythmia
  // (R-R 43-55 samples) that moves the median.
  it.each(real)(`${label}: peaks strategy within 5% of the ECG rate`, (w) => {
    const rate = run(w)[0];
    rec.record(`rate:peaks:${w.signal}:${w.start}`, rate);
    expect(Math.abs(rate / w.truthMedianRate - 1)).toBeLessThanOrEqual(0.05);
  });

  it.each([...new Set(real.map((w) => w.signal))])(
    "%s: mean absolute percentage error under 2% (Charlton's acceptable: 10%)",
    (signal) => {
      const ws = real.filter((w) => w.signal === signal);
      const mape = ws.reduce((s, w) => s + Math.abs(run(w)[0] / w.truthMedianRate - 1), 0) / ws.length;
      expect(mape).toBeLessThan(0.02);
    }
  );

  it.each(synthetic)(`${label}: spectral strategy within half a bin of truth`, (w) => {
    const rate = run(w, { strategy: "spectral" })[0];
    rec.record(`rate:spectral:${w.signal}:${w.start}`, rate);
    // Resolution is fs / nextPow2(n): 640 samples at 64 Hz pad to 1024, a
    // 3.75 bpm bin. Half a bin of quantisation plus 0.5 bpm for the RSA-
    // modulated rate not sitting on a bin centre.
    const binBpm = (60 * w.fs) / 2 ** Math.ceil(Math.log2(w.stop - w.start));
    expect(Math.abs(rate - w.truthMeanRate)).toBeLessThanOrEqual(binBpm / 2 + 0.5);
  });

  // SDNN / RMSSD are defined on normal-to-normal intervals (Task Force 1996),
  // so every interval the node passes on must span two consecutive true
  // beats: no false beat splitting one, no missed beat merging two. D7,
  // closed: the adaptive-threshold detector's edge false beats broke this and
  // inflated SDNN up to 3.5x.
  it.each(synthetic)(`${label}: every interval HRV uses spans two consecutive true beats`, (w) => {
    const tolerance = Math.round(golden.matchToleranceSeconds * w.fs);
    const beats = detectors.msptdfast(pulseOf(windowSignal(w.signal, w.start, w.stop), w.fs), w.fs);
    const truthIndex = beats.map((b) => w.truthBeats!.findIndex((t) => Math.abs(t - b) <= tolerance));
    expect(truthIndex).not.toContain(-1);
    for (let i = 1; i < truthIndex.length; i++) expect(truthIndex[i] - truthIndex[i - 1]).toBe(1);
  });

  // With true intervals only, what remains is peak timing jitter: a peak
  // lands a sample either side of the truth, worst at 30 Hz under heavy
  // noise. That moves SDNN by up to about one sample period (33 ms at 30 Hz,
  // 16 ms at 64 Hz), which on a small true SDNN is more than 25%. Same logic
  // as the rate bar above.
  it.each(synthetic)(`${label}: SDNN within 25% or one sample period of the true beats' SDNN`, (w) => {
    const sdnn = run(w, { includeVariability: true })[1];
    const truth = intervalVariability(asPeaks(w.truthBeats!), w.fs);
    rec.record(`sdnn:${w.signal}:${w.start}`, { package: sdnn, truth });
    expect(Math.abs(sdnn - truth)).toBeLessThanOrEqual(Math.max(0.25 * truth, 1000 / w.fs));
  });
});
