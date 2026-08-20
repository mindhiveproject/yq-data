/**
 * Window functions.
 *
 * Tapering a segment before an FFT suppresses the spectral leakage caused by
 * treating a finite segment as one period of a periodic signal. Hamming is the
 * default throughout the package, matching the reference implementation.
 */

export type WindowType = "hamming" | "hann" | "blackman" | "rectangular";

const cache = new Map<string, Float32Array>();

/** Builds (and memoizes) a window of the given type and length. */
export function getWindow(type: WindowType, length: number): Float32Array {
  const key = `${type}:${length}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const w = new Float32Array(length);
  const denom = length > 1 ? length - 1 : 1;

  for (let i = 0; i < length; i++) {
    const phase = (2 * Math.PI * i) / denom;
    switch (type) {
      case "hamming":
        w[i] = 0.54 - 0.46 * Math.cos(phase);
        break;
      case "hann":
        w[i] = 0.5 * (1 - Math.cos(phase));
        break;
      case "blackman":
        w[i] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
        break;
      case "rectangular":
        w[i] = 1;
        break;
    }
  }

  cache.set(key, w);
  return w;
}

/** Multiplies a signal by a window, returning a new array. */
export function applyWindow(
  signal: ArrayLike<number>,
  type: WindowType = "hamming"
): Float32Array {
  const w = getWindow(type, signal.length);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * w[i];
  return out;
}

/** Sum of squared window coefficients, used to normalize power spectra. */
export function windowPower(type: WindowType, length: number): number {
  const w = getWindow(type, length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += w[i] * w[i];
  return sum;
}
