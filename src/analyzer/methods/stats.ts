/**
 * Descriptive statistics and amplitude normalization.
 *
 * These stay dependency-free on purpose: mathjs is pulled in only for the FFT
 * (see fft.ts), and widening that import surface for a mean or a least-squares
 * solve would cost bundle size for no expressive gain.
 */

export function mean(x: ArrayLike<number>): number {
  if (x.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  return sum / x.length;
}

export function variance(x: ArrayLike<number>, sample = false): number {
  if (x.length === 0) return 0;
  const m = mean(x);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - m;
    sum += d * d;
  }
  const denom = sample ? Math.max(1, x.length - 1) : x.length;
  return sum / denom;
}

export function standardDeviation(x: ArrayLike<number>, sample = false): number {
  return Math.sqrt(variance(x, sample));
}

export function rms(x: ArrayLike<number>): number {
  if (x.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
}

/** Root mean square expressed in decibels relative to full scale. */
export function dbfs(value: number, floor = -100): number {
  if (value <= 0) return floor;
  return Math.max(floor, 20 * Math.log10(value));
}

export function minimum(x: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] < m) m = x[i];
  return isFinite(m) ? m : 0;
}

export function maximum(x: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
  return isFinite(m) ? m : 0;
}

/** Pearson product-moment correlation between two equal-length signals. */
export function correlation(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  const ma = mean(a);
  const mb = mean(b);

  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }

  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : 0;
}

/**
 * Least-squares polynomial fit, returning coefficients low order first.
 *
 * Solves the normal equations with Gaussian elimination. Fine for the low
 * degrees used here (the PPG detrend is degree 6); a Vandermonde system gets
 * ill-conditioned well before degree 20, so this is not a general-purpose fit.
 */
export function polyfit(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  degree: number
): number[] {
  const n = Math.min(x.length, y.length);
  const terms = degree + 1;

  // Normal equations: (V^T V) c = V^T y, built from power sums.
  const powerSums = new Array(2 * degree + 1).fill(0);
  for (let i = 0; i < n; i++) {
    let p = 1;
    for (let k = 0; k <= 2 * degree; k++) {
      powerSums[k] += p;
      p *= x[i];
    }
  }

  const rhs = new Array(terms).fill(0);
  for (let i = 0; i < n; i++) {
    let p = 1;
    for (let k = 0; k < terms; k++) {
      rhs[k] += y[i] * p;
      p *= x[i];
    }
  }

  const matrix: number[][] = [];
  for (let r = 0; r < terms; r++) {
    const row = new Array(terms + 1);
    for (let c = 0; c < terms; c++) row[c] = powerSums[r + c];
    row[terms] = rhs[r];
    matrix.push(row);
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < terms; col++) {
    let pivot = col;
    for (let r = col + 1; r < terms; r++) {
      if (Math.abs(matrix[r][col]) > Math.abs(matrix[pivot][col])) pivot = r;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) continue;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];

    for (let r = 0; r < terms; r++) {
      if (r === col) continue;
      const factor = matrix[r][col] / matrix[col][col];
      for (let c = col; c <= terms; c++) matrix[r][c] -= factor * matrix[col][c];
    }
  }

  const coefficients = new Array(terms).fill(0);
  for (let i = 0; i < terms; i++) {
    if (Math.abs(matrix[i][i]) > 1e-12) {
      coefficients[i] = matrix[i][terms] / matrix[i][i];
    }
  }
  return coefficients;
}

/** Evaluates a polynomial given coefficients low order first. */
export function polyval(coefficients: number[], x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = result * x + coefficients[i];
  }
  return result;
}

/**
 * Removes a polynomial trend from a signal.
 *
 * Degree 0 subtracts the mean; degree 1 removes linear drift; higher degrees
 * remove the slow baseline wander that dominates raw PPG.
 */
export function detrend(
  signal: ArrayLike<number>,
  degree = 1,
  samplingRate?: number
): Float32Array {
  const n = signal.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  if (degree === 0) {
    const m = mean(signal);
    for (let i = 0; i < n; i++) out[i] = signal[i] - m;
    return out;
  }

  const t = new Float32Array(n);
  const step = samplingRate ? 1 / samplingRate : 1;
  for (let i = 0; i < n; i++) t[i] = i * step;

  const coefficients = polyfit(t, signal, degree);
  for (let i = 0; i < n; i++) out[i] = signal[i] - polyval(coefficients, t[i]);
  return out;
}

/** Rescales a signal to [0, 1]. A flat signal maps to all zeros. */
export function minMaxNormalize(signal: ArrayLike<number>): Float32Array {
  const out = new Float32Array(signal.length);
  const lo = minimum(signal);
  const hi = maximum(signal);
  const range = hi - lo;
  if (range === 0) return out;
  for (let i = 0; i < signal.length; i++) out[i] = (signal[i] - lo) / range;
  return out;
}

/** Rescales a signal to zero mean and unit variance. */
export function zScore(signal: ArrayLike<number>): Float32Array {
  const out = new Float32Array(signal.length);
  const m = mean(signal);
  const sd = standardDeviation(signal);
  if (sd === 0) return out;
  for (let i = 0; i < signal.length; i++) out[i] = (signal[i] - m) / sd;
  return out;
}

/** Maps a value from one range onto another, clamping to the output range. */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin = 0,
  outMax = 1
): number {
  if (inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  const mapped = outMin + t * (outMax - outMin);
  const lo = Math.min(outMin, outMax);
  const hi = Math.max(outMin, outMax);
  return Math.min(hi, Math.max(lo, mapped));
}
