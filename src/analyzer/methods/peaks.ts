/**
 * Peak detection and rate estimation.
 *
 * The adaptive-threshold detector follows the decaying-threshold method of
 * Shin, Lee & Lee (2009), but the rate estimate is derived from the median
 * inter-beat interval with physiological bounds rather than a plain mean over
 * all intervals — a single missed or doubled beat shifts a mean enough to make
 * the output visibly jump, and a median absorbs it.
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
