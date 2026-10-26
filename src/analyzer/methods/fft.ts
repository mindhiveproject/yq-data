/**
 * Frequency-domain transforms.
 *
 * The transform is an iterative radix-2 Cooley-Tukey FFT over two `Float64Array`s
 * (real and imaginary parts), with the bit-reversal permutation and twiddle
 * factors computed once per length and kept. It replaced mathjs's `fft`, which
 * allocates a `Complex` object per bin per stage and was 50 to 100 times slower:
 * a 2048-point spectrum took about 10 ms, which is a tenth of a core for a Muse
 * and more than a core for a 32-channel LSL stream. The numbers it returns are
 * the same to float64 rounding, which the golden suite checks against SciPy.
 */

import { applyWindow, windowPower, windowSum, WindowType } from "./window";

/** Everything a transform of one length needs that does not depend on the data. */
interface FftPlan {
  /** `cos(2πk/n)` for `k < n/2`. */
  cos: Float64Array;
  /** `-sin(2πk/n)` for `k < n/2`: the forward transform's twiddle, `e^(-2πik/n)`. */
  sin: Float64Array;
  /** Bit-reversed index of each position. */
  reverse: Uint32Array;
}

const plans = new Map<number, FftPlan>();

function planFor(n: number): FftPlan {
  const cached = plans.get(n);
  if (cached) return cached;

  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    // Each twiddle from its own angle rather than a running product, so error
    // does not accumulate along the table.
    const angle = (2 * Math.PI * k) / n;
    cos[k] = Math.cos(angle);
    sin[k] = -Math.sin(angle);
  }

  const bits = Math.log2(n);
  const reverse = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }

  const plan = { cos, sin, reverse };
  plans.set(n, plan);
  return plan;
}

/**
 * In-place forward FFT of `re + i·im`, whose length must be a power of two.
 * Unnormalised, with the `e^(-2πikn/N)` sign convention of NumPy and SciPy.
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2) return;

  const { cos, sin, reverse } = planFor(n);

  for (let i = 0; i < n; i++) {
    const j = reverse[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0, k = 0; j < half; j++, k += stride) {
        const wr = cos[k];
        const wi = sin[k];
        const a = start + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Smallest power of two greater than or equal to n. */
export function nextPowerOfTwo(n: number): number {
  if (n < 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

/**
 * Zero-pads a signal up to the next power of two.
 *
 * The radix-2 transform only accepts power-of-two lengths, so this is
 * mandatory rather than an optimization. The padded length is what sets the
 * frequency resolution, and every bin-index calculation downstream uses it.
 */
export function padToPowerOfTwo(signal: ArrayLike<number>): Float32Array {
  const n = nextPowerOfTwo(signal.length);
  if (n === signal.length && signal instanceof Float32Array) return signal;
  const out = new Float32Array(n);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i];
  return out;
}

/** Result of a real-input spectral transform. */
export interface Spectrum {
  /** One-sided spectrum, `fftLength / 2` bins. */
  values: Float32Array;
  /** Frequency in Hz of each bin. */
  frequencies: Float32Array;
  /** Spacing between bins in Hz. */
  resolution: number;
  /** Transform length actually used, after zero padding. */
  fftLength: number;
}

export type SpectrumScaling =
  /**
   * `2 * |X| / sum(w)` (`|X| / sum(w)` at DC). Amplitude of the underlying
   * sinusoid, in the signal's own units, for any window and any zero padding
   * (Heinzel, Rüdiger & Schilling 2002, §9). A sinusoid between two bins
   * still reads low by the window's scalloping loss, up to 1.75 dB for
   * Hamming.
   *
   * The original You-Quantified code divided by the FFT length instead, which
   * reads every bin low by `sum(w) / nfft` (0.54 for an unpadded Hamming
   * window).
   */
  | "magnitude"
  /**
   * `|X|^2 / (fs * sum(w^2))`. A true power spectral density in units²/Hz,
   * independent of window length and shape — the right choice when comparing
   * across devices or window sizes.
   */
  | "psd";

export interface SpectrumOptions {
  /** Sampling rate in Hz. Required for meaningful frequencies. */
  samplingRate: number;
  /** Taper applied before the transform. */
  window?: WindowType;
  /** Subtract the mean before transforming, removing the DC bin's dominance. */
  detrend?: boolean;
  /** Output scaling. See {@link SpectrumScaling}. */
  scaling?: SpectrumScaling;
}

/**
 * Computes the one-sided spectrum of a real signal.
 */
export function spectrum(
  signal: ArrayLike<number>,
  options: SpectrumOptions
): Spectrum {
  const {
    samplingRate,
    window = "hamming",
    detrend = true,
    scaling = "magnitude",
  } = options;

  let prepared = Float32Array.from(signal as ArrayLike<number>);

  if (detrend) {
    let sum = 0;
    for (let i = 0; i < prepared.length; i++) sum += prepared[i];
    const mean = prepared.length > 0 ? sum / prepared.length : 0;
    for (let i = 0; i < prepared.length; i++) prepared[i] -= mean;
  }

  const tapered = applyWindow(prepared, window);
  const padded = padToPowerOfTwo(tapered);
  const fftLength = padded.length;

  const re = Float64Array.from(padded);
  const im = new Float64Array(fftLength);
  fftInPlace(re, im);

  const bins = Math.floor(fftLength / 2);
  const values = new Float32Array(bins);

  if (scaling === "psd") {
    // Normalizing by the window's energy makes the result independent of both
    // window length and window shape.
    const norm = samplingRate * windowPower(window, tapered.length);
    for (let i = 0; i < bins; i++) {
      const power = re[i] * re[i] + im[i] * im[i];
      // Bins other than DC and Nyquist stand in for a negative-frequency twin.
      const oneSided = i === 0 ? power : 2 * power;
      values[i] = norm > 0 ? oneSided / norm : 0;
    }
  } else {
    // The window's coherent sum, not the FFT length: a tapered window scales a
    // sinusoid's peak by sum(w), and zero padding adds nothing to it.
    const gain = windowSum(window, tapered.length);
    for (let i = 0; i < bins; i++) {
      const oneSided = i === 0 ? 1 : 2;
      values[i] =
        gain > 0 ? (oneSided * Math.sqrt(re[i] * re[i] + im[i] * im[i])) / gain : 0;
    }
  }

  const resolution = samplingRate / fftLength;
  const frequencies = new Float32Array(bins);
  for (let i = 0; i < bins; i++) frequencies[i] = i * resolution;

  return { values, frequencies, resolution, fftLength };
}

/**
 * Area under the spectrum between `low` and `high` Hz, and the width of the
 * range actually covered.
 *
 * The spectrum is treated as piecewise linear between bins (trapezoid rule),
 * with the band edges interpolated, so a band edge that falls between bins
 * contributes exactly its share rather than snapping to a whole bin. The range
 * is clipped to the frequencies the spectrum has: 0 to its last bin.
 */
function integrateBand(
  spec: Spectrum,
  low: number,
  high: number
): { area: number; width: number } {
  const { values, resolution } = spec;
  const lo = Math.max(low, 0);
  const hi = Math.min(high, (values.length - 1) * resolution);
  if (values.length < 2 || !(hi > lo)) return { area: 0, width: 0 };

  const valueAt = (frequency: number) => {
    const position = frequency / resolution;
    const index = Math.min(Math.floor(position), values.length - 2);
    const fraction = position - index;
    return values[index] * (1 - fraction) + values[index + 1] * fraction;
  };

  let area = 0;
  let previousFrequency = lo;
  let previousValue = valueAt(lo);
  for (let k = Math.floor(lo / resolution) + 1; k * resolution < hi; k++) {
    const frequency = k * resolution;
    area += ((previousValue + values[k]) / 2) * (frequency - previousFrequency);
    previousFrequency = frequency;
    previousValue = values[k];
  }
  area += ((previousValue + valueAt(hi)) / 2) * (hi - previousFrequency);
  return { area, width: hi - lo };
}

/**
 * Mean spectrum value across the frequency range [low, high]: the area under
 * the spectrum divided by the range covered. On a `"psd"` spectrum that is the
 * mean power density in units²/Hz.
 *
 * Returns 0 when the range falls outside the spectrum, which keeps a
 * misconfigured band from producing NaN downstream in a visual.
 */
export function bandAverage(
  spec: Spectrum,
  low: number,
  high: number
): number {
  const { area, width } = integrateBand(spec, low, high);
  return width > 0 ? area / width : 0;
}

/**
 * Integrates the spectrum across [low, high] — the area under the curve.
 *
 * On a `"psd"` spectrum (units²/Hz) this is the band's power in units² (µV²
 * for EEG), independent of window length and zero padding. Band edges between
 * bins are interpolated. Use {@link bandAverage} for the mean spectral density
 * instead.
 */
export function bandSum(spec: Spectrum, low: number, high: number): number {
  return integrateBand(spec, low, high).area;
}

/**
 * Frequency of the largest spectral peak within [low, high).
 *
 * Used by the heart-rate estimators, where the dominant frequency of a
 * bandpassed pulse waveform is the pulse rate.
 */
export function dominantFrequency(
  spec: Spectrum,
  low = 0,
  high = Infinity
): { frequency: number; value: number } {
  const start = Math.max(0, Math.floor(low / spec.resolution));
  const end = Math.min(
    spec.values.length,
    high === Infinity ? spec.values.length : Math.ceil(high / spec.resolution)
  );

  let bestIndex = -1;
  let best = -Infinity;
  for (let i = start; i < end; i++) {
    if (spec.values[i] > best) {
      best = spec.values[i];
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return { frequency: 0, value: 0 };
  return { frequency: bestIndex * spec.resolution, value: best };
}
