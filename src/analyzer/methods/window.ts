/**
 * Window functions.
 *
 * Tapering a segment before an FFT suppresses the spectral leakage caused by
 * treating a finite segment as one period of a periodic signal. Hamming is the
 * default throughout the package, matching the reference implementation.
 */

export type WindowType = "hamming" | "hann" | "blackman" | "rectangular";

const cache = new Map<string, Float32Array>();

/**
 * Builds (and memoizes) a symmetric window of the given type and length, in
 * float32. The values are {@link windowFunction}'s, so a one-sample window is
 * `[1]`, as in SciPy and NumPy.
 */
export function getWindow(type: WindowType, length: number): Float32Array {
  const key = `${type}:${length}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const w = Float32Array.from(windowFunction(type, length));
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

/**
 * Sum of window coefficients — the length times the window's coherent gain —
 * used to normalize amplitude spectra.
 */
export function windowSum(type: WindowType, length: number): number {
  const w = getWindow(type, length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += w[i];
  return sum;
}

/**
 * Window specification for filter design, as in `scipy.signal.get_window`:
 * a name, or `[name, parameter]` for the parametric windows.
 *
 * | name                         | parameter                        |
 * | ---------------------------- | -------------------------------- |
 * | `kaiser`                     | `beta` (required)                |
 * | `tukey`                      | `alpha`, default 0.5             |
 * | `gaussian`                   | `std` in samples (required)      |
 * | everything else              | none                             |
 */
export type WindowSpec =
  | WindowFunctionName
  | [name: "kaiser" | "tukey" | "gaussian", parameter: number];

/** Windows `windowFunction` can build, under their SciPy names. */
export type WindowFunctionName =
  | "boxcar"
  | "rectangular"
  | "triang"
  | "bartlett"
  | "hann"
  | "hamming"
  | "blackman"
  | "blackmanharris"
  | "nuttall"
  | "flattop"
  | "cosine"
  | "bohman"
  | "kaiser"
  | "tukey"
  | "gaussian";

const COSINE_SUM: Record<string, number[]> = {
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackman: [0.42, 0.5, 0.08],
  blackmanharris: [0.35875, 0.48829, 0.14128, 0.01168],
  nuttall: [0.3635819, 0.4891775, 0.1365995, 0.0106411],
  flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
};

/** Modified Bessel function of the first kind, order 0 (power series). */
export function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 500; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Builds a window in float64, matching `scipy.signal.get_window` value for
 * value.
 *
 * `symmetric` follows SciPy's `fftbins` the other way round: `true` (the
 * default here, as in `scipy.signal.windows.hamming(M)`) is the symmetric form
 * a FIR design wants; `false` is the periodic form used for spectral
 * analysis, which is the symmetric window of length `length + 1` with its last
 * sample dropped.
 *
 * `getWindow` above is the float32, symmetric, non-parametric view of this
 * for the spectral code; this is the exact version for design work, where
 * float32 rounding in the window would show up in the filter coefficients.
 */
export function windowFunction(
  spec: WindowSpec,
  length: number,
  symmetric = true
): Float64Array {
  const [name, parameter] = Array.isArray(spec) ? spec : [spec, undefined];
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`Window length must be a non-negative integer, got ${length}.`);
  }
  if (length <= 1) return new Float64Array(length).fill(1);

  // Periodic = symmetric of length + 1, truncated.
  const m = symmetric ? length : length + 1;
  const w = new Float64Array(m);

  switch (name) {
    case "boxcar":
    case "rectangular":
      w.fill(1);
      break;

    case "hann":
    case "hamming":
    case "blackman":
    case "blackmanharris":
    case "nuttall":
    case "flattop": {
      const a = COSINE_SUM[name];
      for (let i = 0; i < m; i++) {
        const fac = -Math.PI + (2 * Math.PI * i) / (m - 1);
        let v = 0;
        for (let k = 0; k < a.length; k++) v += a[k] * Math.cos(k * fac);
        w[i] = v;
      }
      break;
    }

    case "bartlett":
      for (let i = 0; i < m; i++) {
        w[i] = i <= (m - 1) / 2 ? (2 * i) / (m - 1) : 2 - (2 * i) / (m - 1);
      }
      break;

    case "triang": {
      // Unlike Bartlett, never reaches zero at the ends.
      const half = Math.floor((m + 1) / 2);
      for (let n = 1; n <= half; n++) {
        const v = m % 2 === 0 ? (2 * n - 1) / m : (2 * n) / (m + 1);
        w[n - 1] = v;
        w[m - n] = v;
      }
      break;
    }

    case "cosine":
      for (let i = 0; i < m; i++) w[i] = Math.sin((Math.PI / m) * (i + 0.5));
      break;

    case "bohman":
      for (let i = 1; i < m - 1; i++) {
        const fac = Math.abs(-1 + (2 * i) / (m - 1));
        w[i] = (1 - fac) * Math.cos(Math.PI * fac) + Math.sin(Math.PI * fac) / Math.PI;
      }
      break;

    case "kaiser": {
      if (parameter === undefined) throw new Error("The kaiser window needs a beta: ['kaiser', beta].");
      const alpha = (m - 1) / 2;
      const norm = besselI0(parameter);
      for (let i = 0; i < m; i++) {
        const r = (i - alpha) / alpha;
        w[i] = besselI0(parameter * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
      }
      break;
    }

    case "tukey": {
      const alpha = parameter ?? 0.5;
      if (alpha <= 0) {
        w.fill(1);
      } else if (alpha >= 1) {
        return windowFunction("hann", length, symmetric);
      } else {
        const width = Math.floor((alpha * (m - 1)) / 2);
        for (let i = 0; i < m; i++) {
          if (i <= width) {
            w[i] = 0.5 * (1 + Math.cos(Math.PI * (-1 + (2 * i) / alpha / (m - 1))));
          } else if (i >= m - width - 1) {
            w[i] = 0.5 * (1 + Math.cos(Math.PI * (-2 / alpha + 1 + (2 * i) / alpha / (m - 1))));
          } else {
            w[i] = 1;
          }
        }
      }
      break;
    }

    case "gaussian": {
      if (parameter === undefined) throw new Error("The gaussian window needs a std: ['gaussian', std].");
      for (let i = 0; i < m; i++) {
        const n = i - (m - 1) / 2;
        w[i] = Math.exp(-(n * n) / (2 * parameter * parameter));
      }
      break;
    }

    default:
      throw new Error(`Unknown window "${String(name)}".`);
  }

  return symmetric ? w : w.slice(0, length);
}
