/**
 * Peak detection and rate estimation.
 *
 * Two pulse-beat detectors:
 *
 * - `msptdFast` — MSPTDfast v2 (Charlton et al., 2025), the efficient form of
 *   Multi-Scale Peak and Trough Detection (Bishop & Ercole, 2018). MSPTD and
 *   qppg were the two best of fifteen open-source PPG beat detectors
 *   benchmarked by Charlton et al. (2022); MSPTDfast keeps MSPTD's accuracy at
 *   about a quarter of its cost. This is the HeartRate node's default.
 * - `adaptiveThresholdPeaks` — the decaying-threshold method of Shin, Lee &
 *   Lee (2009), benchmarked as "ATM" in Charlton et al. (2022), where it was
 *   not among the detectors that performed well at rest.
 *
 * The rate estimate is derived from the median inter-beat interval with
 * physiological bounds rather than a plain mean over all intervals — a single
 * missed or doubled beat shifts a mean enough to make the output visibly jump,
 * and a median absorbs it.
 *
 * Bishop, S.M. & Ercole, A. (2018). Multi-scale peak and trough detection
 * optimised for periodic and quasi-periodic neuroscience data. Acta
 * Neurochirurgica Supplement 126, 189–195.
 * https://doi.org/10.1007/978-3-319-65798-1_39
 *
 * Charlton, P.H. et al. (2022). Detecting beats in the photoplethysmogram:
 * benchmarking open-source algorithms. Physiological Measurement 43(8),
 * 085007. https://doi.org/10.1088/1361-6579/ac826d
 *
 * Charlton, P.H., Mant, J. & Kyriacou, P.A. (2025). The MSPTDfast
 * photoplethysmography beat detection algorithm: design, benchmarking, and
 * open-source distribution. Physiological Measurement 46, 035002.
 * https://doi.org/10.1088/1361-6579/adb89e
 *
 * Shin, H.S., Lee, C. & Lee, M. (2009). Adaptive threshold method for the peak
 * detection of photoplethysmographic waveform. Computers in Biology and
 * Medicine, 39(12), 1145–1152. https://doi.org/10.1016/j.compbiomed.2009.10.006
 */
import { mean, maximum, standardDeviation } from "./stats";

export interface Peak {
  /** Sample index of the peak. */
  index: number;
  /** Signal value at the peak. */
  value: number;
}

export interface PeakOptions {
  /** Sampling rate in Hz, used to enforce the refractory period. */
  samplingRate: number;
  /** Minimum seconds between peaks. 0.3 s ≈ a 200 bpm ceiling. */
  refractoryPeriod?: number;
  /** Peaks below this fraction of the signal's range are ignored. */
  minRelativeHeight?: number;
}

/**
 * Adaptive-threshold peak detection, after Shin, Lee & Lee (2009).
 *
 * The threshold starts near the signal maximum and decays; a sample crossing
 * it opens a candidate, and the local maximum before the signal falls back
 * under the threshold is recorded. Because the threshold tracks the signal,
 * this handles the slow amplitude drift typical of optical pulse signals far
 * better than a fixed cutoff.
 *
 * The decay rate is the paper's: proportional to the previous peak's amplitude
 * plus the signal's standard deviation, scaled by the sampling rate.
 *
 * @see https://doi.org/10.1016/j.compbiomed.2009.10.006
 */
export function adaptiveThresholdPeaks(
  signal: ArrayLike<number>,
  options: PeakOptions
): { peaks: Peak[]; threshold: Float32Array } {
  const {
    samplingRate,
    refractoryPeriod = 0.3,
    minRelativeHeight = 0,
  } = options;

  const n = signal.length;
  const threshold = new Float32Array(n);
  const peaks: Peak[] = [];
  if (n === 0) return { peaks, threshold };

  const sd = standardDeviation(signal);
  const peak = maximum(signal);
  const minSeparation = Math.max(1, Math.round(refractoryPeriod * samplingRate));
  const heightFloor = minRelativeHeight * peak;

  threshold[0] = peak * 0.2;
  let lastPeakAmplitude = threshold[0];

  let candidateIndex = -1;
  let candidateValue = -Infinity;

  for (let i = 1; i < n; i++) {
    // Decay proportional to the last peak's amplitude, so the detector
    // re-arms faster on a strong beat than on a weak one.
    threshold[i] =
      threshold[i - 1] - Math.abs((lastPeakAmplitude + sd) / samplingRate) * 0.6;

    if (signal[i] > threshold[i]) {
      threshold[i] = signal[i];
      if (signal[i] > candidateValue) {
        candidateValue = signal[i];
        candidateIndex = i;
      }
    } else if (candidateIndex >= 0) {
      const previous = peaks[peaks.length - 1];
      const farEnough =
        !previous || candidateIndex - previous.index >= minSeparation;

      if (farEnough && candidateValue >= heightFloor) {
        peaks.push({ index: candidateIndex, value: candidateValue });
        lastPeakAmplitude = candidateValue;
      } else if (previous && candidateValue > previous.value) {
        // Within the refractory window, keep whichever candidate is larger.
        previous.index = candidateIndex;
        previous.value = candidateValue;
        lastPeakAmplitude = candidateValue;
      }

      candidateIndex = -1;
      candidateValue = -Infinity;
    }
  }

  return { peaks, threshold };
}

export interface Beats {
  /** Systolic peaks. */
  peaks: Peak[];
  /** Pulse onsets: the troughs that open each beat. */
  onsets: Peak[];
}

/** MSPTDfast v2's configuration (ppg-beats `msptdfastv2_beat_detector.m`). */
const MSPTD_WINDOW_SECONDS = 6;
const MSPTD_WINDOW_OVERLAP = 0.2;
const MSPTD_DOWNSAMPLE_HZ = 20;
/** Scales whose period implies a rate below this are never computed. */
const MSPTD_MIN_RATE_HZ = 30 / 60;

/**
 * MSPTDfast v2 beat detection: Multi-Scale Peak and Trough Detection with the
 * speed-ups of Charlton et al. (2025).
 *
 * MSPTD needs no amplitude threshold. For each scale k it marks the samples
 * larger (or smaller) than both neighbours k samples away, picks the scale λ
 * with the most such maxima, and keeps the samples that are maxima at every
 * scale up to λ. A peak is a peak because it dominates the surrounding half
 * beat or so, whatever the signal's offset or gain. The fast variant splits
 * the input into 6 s windows overlapping by 20%, decimates each to about
 * 20 Hz, skips scales slower than 30 bpm, and then moves each candidate to the
 * true extremum of the full-rate signal within a small tolerance.
 *
 * A step-for-step port of the reference MATLAB (ppg-beats toolbox,
 * `msptdfastv2_beat_detector.m`), verified index-for-index against it. Two
 * MATLAB behaviours are kept on purpose:
 * - a window whose dominant scale is λ = 1 yields no beats. MATLAB's `sum`
 *   over a one-row scalogram collapses to a scalar. λ = 1 means
 *   sample-to-sample noise dominates, so the window has no beats to report.
 * - the decimated-to-full-rate index mapping is MATLAB's 1-based `p * factor`,
 *   which lands up to `factor - 1` samples late before refinement.
 *
 * Where MATLAB would index past a window's end during refinement (it errors),
 * the search range is clamped instead. The output is the same wherever MATLAB
 * runs. The 6 s window length is rounded to whole samples; MATLAB requires it
 * to be whole already.
 *
 * By construction a beat within about half an inter-beat interval of the
 * input's ends is not found: it cannot dominate the half beat on both sides.
 *
 * @see https://doi.org/10.1088/1361-6579/adb89e
 * @see https://github.com/peterhcharlton/ppg-beats
 *
 * Ported from ppg-beats `msptdfastv2_beat_detector.m`, MIT License,
 * Copyright (c) 2022-2024 Peter H. Charlton. Permission is hereby granted,
 * free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions
 * of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
export function msptdFast(signal: ArrayLike<number>, samplingRate: number): Beats {
  const n = signal.length;
  const fs = samplingRate;
  const winSamples = Math.round(MSPTD_WINDOW_SECONDS * fs);

  // Window bounds, inclusive at both ends (MATLAB's `start:start + n`).
  const starts: number[] = [];
  const ends: number[] = [];
  if (n <= winSamples) {
    starts.push(0);
    ends.push(n - 1);
  } else {
    const offset = Math.round(winSamples * (1 - MSPTD_WINDOW_OVERLAP));
    for (let s = 0; s + 1 <= n - winSamples; s += offset) {
      starts.push(s);
      ends.push(s + winSamples);
    }
    // A last window flush with the end, so the whole input is covered.
    if (ends[ends.length - 1] < n - 1) {
      starts.push(n - winSamples - 1);
      ends.push(n - 1);
    }
  }

  const downsample = fs > MSPTD_DOWNSAMPLE_HZ;
  const factor = downsample ? Math.floor(fs / MSPTD_DOWNSAMPLE_HZ) : 1;
  const relFs = downsample ? fs / factor : fs;
  const tolSeconds = relFs < 10 ? 0.2 : relFs < 20 ? 0.1 : 0.05;
  const tol = Math.ceil(fs * tolSeconds);

  const peakSet = new Set<number>();
  const onsetSet = new Set<number>();

  for (let w = 0; w < starts.length; w++) {
    const start = starts[w];
    const length = ends[w] - start + 1;

    const decimated = new Float64Array(Math.ceil(length / factor));
    for (let i = 0; i < decimated.length; i++) decimated[i] = signal[start + i * factor];

    const { maxima, minima } = msptdCandidates(decimated, relFs);

    const refine = (candidates: number[], pickMax: boolean, into: Set<number>) => {
      for (const c of candidates) {
        const centre = downsample ? (c + 1) * factor - 1 : c;
        const lo = Math.max(0, centre - tol);
        const hi = Math.min(length - 1, centre + tol);
        let best = lo;
        for (let i = lo + 1; i <= hi; i++) {
          const v = signal[start + i];
          if (pickMax ? v > signal[start + best] : v < signal[start + best]) best = i;
        }
        into.add(start + best);
      }
    };
    refine(maxima, true, peakSet);
    refine(minima, false, onsetSet);
  }

  const asPeaks = (indices: Set<number>): Peak[] =>
    Array.from(indices)
      .sort((a, b) => a - b)
      .map((index) => ({ index, value: signal[index] }));

  return { peaks: asPeaks(peakSet), onsets: asPeaks(onsetSet) };
}

/**
 * One MSPTD window: the samples that are local maxima (or minima) at every
 * scale up to the scale with the most of them. Indices into `x`.
 */
function msptdCandidates(
  x: ArrayLike<number>,
  samplingRate: number
): { maxima: number[]; minima: number[] } {
  const n = x.length;
  const longest = Math.ceil(n / 2) - 1;
  const duration = n / samplingRate;

  // Largest scale whose implied rate is still at least 30 bpm.
  let maxScale = 0;
  for (let k = 1; k <= longest; k++) {
    if (longest / k / duration >= MSPTD_MIN_RATE_HZ) maxScale = k;
  }
  if (maxScale === 0) return { maxima: [], minima: [] };

  const y = linearDetrend(x);

  // Count, per scale, the local maxima and minima at that scale.
  const isMax = (j: number, k: number) => y[j] > y[j - k] && y[j] > y[j + k];
  const isMin = (j: number, k: number) => y[j] < y[j - k] && y[j] < y[j + k];
  let lambdaMax = 1;
  let lambdaMin = 1;
  let bestMax = -1;
  let bestMin = -1;
  for (let k = 1; k <= maxScale; k++) {
    let countMax = 0;
    let countMin = 0;
    for (let j = k; j < n - k; j++) {
      if (isMax(j, k)) countMax++;
      else if (isMin(j, k)) countMin++;
    }
    // Strict >: the first scale wins a tie, as MATLAB's max() does.
    if (countMax > bestMax) {
      bestMax = countMax;
      lambdaMax = k;
    }
    if (countMin > bestMin) {
      bestMin = countMin;
      lambdaMin = k;
    }
  }

  const everyScale = (lambda: number, test: (j: number, k: number) => boolean) => {
    const out: number[] = [];
    // λ = 1 finds nothing in the reference MATLAB; see msptdFast.
    if (lambda < 2) return out;
    for (let j = lambda; j < n - lambda; j++) {
      let all = true;
      for (let k = 1; k <= lambda && all; k++) all = test(j, k);
      if (all) out.push(j);
    }
    return out;
  };

  return { maxima: everyScale(lambdaMax, isMax), minima: everyScale(lambdaMin, isMin) };
}

/** Removes the least-squares straight line, in float64 (MATLAB `detrend(x)`). */
function linearDetrend(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const tMean = (n - 1) / 2;
  let xMean = 0;
  for (let i = 0; i < n; i++) xMean += x[i];
  xMean /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - tMean) * (x[i] - xMean);
    sxx += (i - tMean) * (i - tMean);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  for (let i = 0; i < n; i++) out[i] = x[i] - xMean - slope * (i - tMean);
  return out;
}

/**
 * Drops a peak that has no trough between it and its neighbour, keeping the
 * higher of the two. Rule (ii) of the ppg-beats toolbox's
 * `tidy_peaks_and_onsets`, which its benchmark applies to every detector.
 *
 * MSPTDfast's windows overlap, and the same beat seen from two windows can
 * refine to adjacent samples, one or two apart. A plain set of indices keeps
 * both. Left in, the pair is a 10 ms "interval", which the rate's median
 * absorbs but SDNN and RMSSD do not.
 */
export function ensureTroughBetweenPeaks(
  signal: ArrayLike<number>,
  peaks: Peak[]
): Peak[] {
  const troughs = localMinima(signal);
  // prefix[i] = number of troughs in [0, i).
  const prefix = new Int32Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) prefix[i + 1] = prefix[i] + (troughs[i] ? 1 : 0);
  const troughBetween = (a: number, b: number) => b - a > 1 && prefix[b] - prefix[a + 1] > 0;

  let kept = peaks.slice();
  for (;;) {
    const drop = new Set<number>();
    for (let i = 0; i + 1 < kept.length; i++) {
      if (!troughBetween(kept[i].index, kept[i + 1].index)) {
        // The lower goes; on a tie the earlier, as MATLAB's min() picks.
        drop.add(kept[i + 1].value < kept[i].value ? i + 1 : i);
      }
    }
    if (drop.size === 0) return kept;
    kept = kept.filter((_, i) => !drop.has(i));
  }
}

/**
 * Local minima, as MATLAB `islocalmin` marks them: a sample below both
 * neighbours, or the middle of a flat run that is. The ends never qualify.
 */
function localMinima(x: ArrayLike<number>): Uint8Array {
  const n = x.length;
  const out = new Uint8Array(n);
  let i = 1;
  while (i < n - 1) {
    if (x[i] < x[i - 1]) {
      let j = i;
      while (j + 1 < n && x[j + 1] === x[i]) j++;
      if (j + 1 < n && x[j + 1] > x[i]) out[(i + j) >> 1] = 1;
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Intervals between consecutive peaks, in seconds. */
export function peakIntervals(
  peaks: Peak[],
  samplingRate: number
): Float32Array {
  if (peaks.length < 2) return new Float32Array(0);
  const out = new Float32Array(peaks.length - 1);
  for (let i = 1; i < peaks.length; i++) {
    out[i - 1] = (peaks[i].index - peaks[i - 1].index) / samplingRate;
  }
  return out;
}

export function median(x: ArrayLike<number>): number {
  if (x.length === 0) return 0;
  const sorted = Array.from(x).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export interface RateOptions {
  /** Lowest plausible rate in beats per minute. */
  minRate?: number;
  /** Highest plausible rate in beats per minute. */
  maxRate?: number;
}

/**
 * Estimates a rate in beats per minute from detected peaks.
 *
 * Returns 0 when there are too few peaks to be confident, which callers
 * should treat as "no estimate yet" rather than "a rate of zero".
 */
export function rateFromPeaks(
  peaks: Peak[],
  samplingRate: number,
  options: RateOptions = {}
): number {
  const { minRate = 40, maxRate = 200 } = options;

  const intervals = peakIntervals(peaks, samplingRate);
  if (intervals.length === 0) return 0;

  const plausible: number[] = [];
  for (let i = 0; i < intervals.length; i++) {
    const bpm = 60 / intervals[i];
    if (bpm >= minRate && bpm <= maxRate) plausible.push(bpm);
  }

  if (plausible.length === 0) return 0;
  return median(plausible);
}

/** Heart-rate variability as the standard deviation of inter-beat intervals, in ms. */
export function intervalVariability(
  peaks: Peak[],
  samplingRate: number
): number {
  const intervals = peakIntervals(peaks, samplingRate);
  if (intervals.length < 2) return 0;
  return standardDeviation(intervals, true) * 1000;
}

/** Root mean square of successive interval differences (RMSSD), in ms. */
export function rmssd(peaks: Peak[], samplingRate: number): number {
  const intervals = peakIntervals(peaks, samplingRate);
  if (intervals.length < 2) return 0;

  const diffs: number[] = [];
  for (let i = 1; i < intervals.length; i++) {
    diffs.push((intervals[i] - intervals[i - 1]) * 1000);
  }

  return Math.sqrt(mean(diffs.map((d) => d * d)));
}
