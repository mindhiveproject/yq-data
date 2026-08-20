/**
 * Frequency-domain transforms.
 *
 * This is the *only* module that touches mathjs. It uses mathjs's factory
 * entry points rather than the monolithic `math` object so that a consuming
 * bundler tree-shakes everything except `fft` and its dependencies — mathjs is
 * declared as an external dependency in tsup.config.ts, so the shaking happens
 * in the app's build rather than being defeated by inlining it into dist/.
 *
 * If mathjs ever becomes too heavy to justify, replacing this file with a
 * hand-rolled radix-2 transform is the whole of the migration.
 */
import { create, fftDependencies } from "mathjs";

import { applyWindow, windowPower, WindowType } from "./window";

const { fft: mathFft } = create(fftDependencies, { matrix: "Array" });

/** Smallest power of two greater than or equal to n. */
export function nextPowerOfTwo(n: number): number {
  if (n < 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

/**
 * Zero-pads a signal up to the next power of two.
 *
 * mathjs's `fft` is a radix-2 Cooley-Tukey implementation and only accepts
 * power-of-two lengths, so this is mandatory rather than an optimization. The
 * padded length is what sets the frequency resolution, and every bin-index
 * calculation downstream uses it.
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
   * `2 * |X| / N`. Amplitude of the underlying sinusoid, in the signal's own
   * units. This is what the original You-Quantified band-power code produced,
   * so it is the default for numerical parity with existing visuals.
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

  // mathjs wants a plain array; its Complex results carry .re / .im. The
  // declared return type follows the input type, so the cast is unavoidable.
  const transformed = mathFft(Array.from(padded)) as unknown as Array<{
    re: number;
    im: number;
  }>;

  const bins = Math.floor(fftLength / 2);
  const values = new Float32Array(bins);

  if (scaling === "psd") {
    // Normalizing by the window's energy makes the result independent of both
    // window length and window shape.
    const norm = samplingRate * windowPower(window, tapered.length);
    for (let i = 0; i < bins; i++) {
      const { re, im } = transformed[i];
      const power = re * re + im * im;
      // Bins other than DC and Nyquist stand in for a negative-frequency twin.
      const oneSided = i === 0 ? power : 2 * power;
      values[i] = norm > 0 ? oneSided / norm : 0;
    }
  } else {
    for (let i = 0; i < bins; i++) {
      const { re, im } = transformed[i];
      values[i] = (2 * Math.sqrt(re * re + im * im)) / fftLength;
    }
  }

  const resolution = samplingRate / fftLength;
  const frequencies = new Float32Array(bins);
  for (let i = 0; i < bins; i++) frequencies[i] = i * resolution;

  return { values, frequencies, resolution, fftLength };
}

/**
 * Averages spectrum values across a closed-open frequency range [low, high).
 *
 * Returns 0 when the range falls outside the spectrum, which keeps a
 * misconfigured band from producing NaN downstream in a visual.
 */
export function bandAverage(
  spec: Spectrum,
  low: number,
  high: number
): number {
  const start = Math.max(0, Math.floor(low / spec.resolution));
  const end = Math.min(spec.values.length, Math.floor(high / spec.resolution));
  if (end <= start) return 0;

  let sum = 0;
  for (let i = start; i < end; i++) sum += spec.values[i];
  return sum / (end - start);
}

/** Integrates spectrum values across [low, high), for total band power. */
export function bandSum(spec: Spectrum, low: number, high: number): number {
  const start = Math.max(0, Math.floor(low / spec.resolution));
  const end = Math.min(spec.values.length, Math.floor(high / spec.resolution));

  let sum = 0;
  for (let i = start; i < end; i++) sum += spec.values[i];
  return sum;
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
