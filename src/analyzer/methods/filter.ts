/**
 * Applying digital filters.
 *
 * `lfilter`, `sosfilt`, `filtfilt` and `sosfiltfilt` follow the semantics of
 * their SciPy namesakes, including initial conditions (`zi`) in SciPy's
 * transposed direct-form II layout and the steady-state seeding and edge
 * padding that `filtfilt` uses. Designing the coefficients lives in
 * `filter_design.ts`.
 *
 * All arithmetic runs in float64 and is rounded to float32 once, on the way
 * out, which is the width the rest of the package passes around. (Feeding
 * float32 outputs back through the recursion would put float32 rounding into
 * every sample of an IIR filter, which a pole near z = 1 amplifies.)
 */

import { Biquad, FilterCoefficients } from "./filter_design";


/** Edge extension used by `filtfilt`: `scipy.signal.filtfilt(padtype=...)`. */
export type PadType = "odd" | "even" | "constant" | "none";

export interface FiltfiltOptions {
  /** How the signal is extended at both ends. Default `'odd'`, as in SciPy. */
  padtype?: PadType;
  /**
   * Samples of extension at each end. Default: SciPy's
   * `3 * max(len(a), len(b))` (`sosfiltfilt`: 3 per section-order), capped at
   * `x.length - 1` so that short windows still filter. An explicit `padlen`
   * must be shorter than the signal, as in SciPy.
   */
  padlen?: number;
}

// ---------------------------------------------------------------------------
// Direct and cascaded filtering

/** Pads or trims `c` to `n` entries and divides by `a0`. */
function normalized(c: ArrayLike<number>, n: number, a0: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < Math.min(n, c.length); i++) out[i] = c[i] / a0;
  return out;
}

function checkA0(a: ArrayLike<number>) {
  if (a.length === 0 || a[0] === 0) throw new RangeError("a[0] must be nonzero.");
}

/**
 * The float64 core: transposed direct form II, `z` updated in place.
 *
 * `y[n] = z[0] + b0 x[n]`, then each state absorbs the next tap of `b` and
 * `a`. This is the form SciPy's `lfilter` uses, so `z` is interchangeable with
 * SciPy's `zi`.
 */
function filterCore(
  b: ArrayLike<number>,
  a: ArrayLike<number>,
  x: ArrayLike<number>,
  z: Float64Array
): Float64Array {
  checkA0(a);
  const n = Math.max(a.length, b.length);
  const bn = normalized(b, n, a[0]);
  const an = normalized(a, n, a[0]);
  const y = new Float64Array(x.length);
  const last = n - 2;

  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (n === 1) {
      y[i] = bn[0] * xi;
      continue;
    }
    const yi = z[0] + bn[0] * xi;
    for (let k = 0; k < last; k++) z[k] = z[k + 1] + bn[k + 1] * xi - an[k + 1] * yi;
    z[last] = bn[n - 1] * xi - an[n - 1] * yi;
    y[i] = yi;
  }
  return y;
}

function stateSize(b: ArrayLike<number>, a: ArrayLike<number>): number {
  return Math.max(a.length, b.length) - 1;
}

/** Loads a caller's `zi` into a working array, checking its length. */
function loadState(zi: ArrayLike<number> | undefined, size: number): Float64Array {
  if (!zi) return new Float64Array(size);
  if (zi.length !== size) {
    throw new RangeError(`Initial state needs ${size} values, got ${zi.length}.`);
  }
  return Float64Array.from(zi);
}

/**
 * Applies a difference equation in the forward direction
 * (`scipy.signal.lfilter`).
 *
 * `y[n] = (b0*x[n] + ... + bM*x[n-M] - a1*y[n-1] - ... - aN*y[n-N]) / a0`
 *
 * `zi` is the initial state, `max(len(a), len(b)) - 1` values in SciPy's
 * layout; pass `lfilterZi(b, a)` scaled by the first sample to start from a
 * steady state. When given, `zi` is **updated in place** to the final state,
 * so a stream can be filtered chunk by chunk with no discontinuity at the
 * packet boundaries — SciPy's `zf`, without the second return value.
 */
export function lfilter(
  b: ArrayLike<number>,
  a: ArrayLike<number>,
  x: ArrayLike<number>,
  zi?: number[]
): Float32Array {
  const z = loadState(zi, stateSize(b, a));
  const y = filterCore(b, a, x, z);
  if (zi) for (let k = 0; k < z.length; k++) zi[k] = z[k];
  return Float32Array.from(y);
}

/**
 * Initial state for the step response of `(b, a)` (`scipy.signal.lfilter_zi`):
 * multiplied by a constant input level, it is the state of a filter that has
 * been running on that constant forever.
 *
 * A filter with a pole at z = 1 (`sum(a) = 0`) has no steady state; SciPy
 * returns non-finite values there, this returns zeros.
 */
export function lfilterZi(b: ArrayLike<number>, a: ArrayLike<number>): number[] {
  checkA0(a);
  const n = Math.max(a.length, b.length);
  if (n < 2) return [];
  const bn = normalized(b, n, a[0]);
  const an = normalized(a, n, a[0]);

  let sumA = 0;
  let sumB = 0;
  for (let k = 0; k < n; k++) sumA += an[k];
  for (let k = 1; k < n; k++) sumB += bn[k] - an[k] * bn[0];
  if (Math.abs(sumA) < 1e-12) return new Array(n - 1).fill(0);

  const zi = new Array<number>(n - 1);
  zi[0] = sumB / sumA;
  let asum = 1;
  let csum = 0;
  for (let k = 1; k < n - 1; k++) {
    asum += an[k];
    csum += bn[k] - an[k] * bn[0];
    zi[k] = asum * zi[0] - csum;
  }
  return zi;
}

/**
 * Initial state for a cascade (`scipy.signal.sosfilt_zi`): one entry per
 * section, each scaled by the DC gain of the sections before it.
 */
export function sosfiltZi(sections: FilterCoefficients[]): number[][] {
  let level = 1;
  return sections.map(({ b, a }) => {
    const zi = lfilterZi(b, a).map((v) => v * level);
    const sumA = a.reduce((s, v) => s + v, 0);
    const gain = Math.abs(sumA) > 1e-12 ? b.reduce((s, v) => s + v, 0) / sumA : 0;
    level *= gain;
    return zi;
  });
}

function cascadeCore(
  sections: FilterCoefficients[],
  x: ArrayLike<number>,
  states: Float64Array[]
): Float64Array {
  let signal: ArrayLike<number> = x;
  sections.forEach(({ b, a }, i) => {
    signal = filterCore(b, a, signal, states[i]);
  });
  return signal instanceof Float64Array ? signal : Float64Array.from(signal);
}

/**
 * Runs a signal through a cascade of sections (`scipy.signal.sosfilt`).
 *
 * Sections are usually biquads from `butter(..., { output: "sos" })`, but any
 * `(b, a)` pair works, so a FIR filter is a cascade of one. `zi` has one state
 * array per section and is updated in place, as in `lfilter`.
 */
export function sosfilt(
  sections: FilterCoefficients[],
  x: ArrayLike<number>,
  zi?: number[][]
): Float32Array {
  if (zi && zi.length !== sections.length) {
    throw new RangeError(`Initial state needs ${sections.length} sections, got ${zi.length}.`);
  }
  const states = sections.map(({ b, a }, i) => loadState(zi?.[i], stateSize(b, a)));
  const y = cascadeCore(sections, x, states);
  if (zi) states.forEach((z, i) => z.forEach((v, k) => (zi[i][k] = v)));
  return Float32Array.from(y);
}

// ---------------------------------------------------------------------------
// Zero-phase filtering

/** Extends `x` by `n` samples at each end (`scipy.signal._arraytools`). */
function extend(x: ArrayLike<number>, n: number, padtype: PadType): Float64Array {
  if (n <= 0 || padtype === "none") return Float64Array.from(x);
  const len = x.length;
  const out = new Float64Array(len + 2 * n);
  const first = x[0];
  const last = x[len - 1];

  for (let i = 0; i < len; i++) out[n + i] = x[i];
  for (let i = 0; i < n; i++) {
    switch (padtype) {
      case "odd":
        out[i] = 2 * first - x[n - i];
        out[n + len + i] = 2 * last - x[len - 2 - i];
        break;
      case "even":
        out[i] = x[n - i];
        out[n + len + i] = x[len - 2 - i];
        break;
      case "constant":
        out[i] = first;
        out[n + len + i] = last;
        break;
    }
  }
  return out;
}

const PAD_TYPES: PadType[] = ["odd", "even", "constant", "none"];

function resolvePadding(
  options: PadType | FiltfiltOptions,
  length: number,
  defaultPadlen: number
): { padtype: PadType; padlen: number } {
  const { padtype = "odd", padlen } = typeof options === "string" ? { padtype: options } : options;
  if (!PAD_TYPES.includes(padtype)) {
    throw new RangeError(`padtype must be one of ${PAD_TYPES.join(", ")}; got "${padtype}".`);
  }
  if (padlen !== undefined && (padlen < 0 || padlen >= length)) {
    throw new RangeError(
      `padlen must be at least 0 and less than the signal length (${length}); got ${padlen}.`
    );
  }
  const n = padlen ?? Math.min(defaultPadlen, Math.max(0, length - 1));
  return { padtype, padlen: padtype === "none" ? 0 : n };
}

/**
 * Forward then backward, over the extended signal, each pass starting from the
 * steady state of its first sample (`filtfilt`'s default `method='pad'`).
 */
function zeroPhase(
  x: ArrayLike<number>,
  padtype: PadType,
  padlen: number,
  pass: (signal: Float64Array, seedLevel: number) => Float64Array
): Float32Array {
  if (x.length === 0) return new Float32Array(0);
  const extended = extend(x, padlen, padtype);
  const forward = pass(extended, extended[0]);
  const reversed = forward.reverse();
  const backward = pass(reversed, reversed[0]).reverse();
  return Float32Array.from(backward.subarray(padlen, padlen + x.length));
}

/**
 * Zero-phase filtering: forward, then backward (`scipy.signal.filtfilt`).
 *
 * Squares the magnitude response but cancels phase distortion entirely, which
 * matters when the *timing* of a feature is the measurement — peak positions
 * in a PPG pulse, for instance.
 *
 * The edges get two treatments, as in SciPy. The signal is extended by
 * `padtype` (odd reflection by default), and each pass starts from the steady
 * state for its first sample rather than from zero. Padding alone is not
 * enough: a zero state still sees the first sample as a step from 0, and the
 * transient of that step (the size of the signal's offset) leaks into the
 * result.
 *
 * Differs from SciPy only in that a signal too short for the default `padlen`
 * is padded as far as it allows instead of raising. For high-order or
 * narrow-band filters prefer `sosfiltfilt` — `filtfilt` with `ba`
 * coefficients inherits their numerical fragility.
 */
export function filtfilt(
  b: ArrayLike<number>,
  a: ArrayLike<number>,
  x: ArrayLike<number>,
  options: PadType | FiltfiltOptions = {}
): Float32Array {
  const { padtype, padlen } = resolvePadding(
    options,
    x.length,
    3 * Math.max(a.length, b.length)
  );
  const zi = lfilterZi(b, a);
  return zeroPhase(x, padtype, padlen, (signal, level) =>
    filterCore(b, a, signal, Float64Array.from(zi, (v) => v * level))
  );
}

/**
 * Zero-phase filtering through a cascade (`scipy.signal.sosfiltfilt`).
 *
 * The whole cascade runs forward and then backward, each section seeded at the
 * steady state of the signal it receives (`sosfiltZi`). Padding is sized by the
 * cascade as a whole: `3 * (2 * sections + 1 - n)`, where `n` counts the
 * trailing-zero coefficient pairs, as in SciPy.
 */
export function sosfiltfilt(
  sections: Biquad[],
  x: ArrayLike<number>,
  options: PadType | FiltfiltOptions = {}
): Float32Array {
  const flatB = sections.filter((s) => s.b[2] === 0).length;
  const flatA = sections.filter((s) => s.a[2] === 0).length;
  const { padtype, padlen } = resolvePadding(
    options,
    x.length,
    3 * (2 * sections.length + 1 - Math.min(flatB, flatA))
  );
  const zi = sosfiltZi(sections);
  return zeroPhase(x, padtype, padlen, (signal, level) =>
    cascadeCore(
      sections,
      signal,
      zi.map((z) => Float64Array.from(z, (v) => v * level))
    )
  );
}

/**
 * 15-tap FIR lowpass from the Shin, Lee & Lee (2009) PPG peak-detection
 * pipeline, where it is the preprocessing stage ahead of the adaptive
 * threshold.
 *
 * Retained verbatim so heart-rate output stays comparable with both the paper
 * and the original You-Quantified implementation.
 *
 * @see https://doi.org/10.1016/j.compbiomed.2009.10.006
 */
export const PPG_LOWPASS_FIR: FilterCoefficients = {
  b: [
    -0.00588043, -0.00620177, -0.00106799, 0.02467073, 0.07864882, 0.15035629,
    0.21289894, 0.23779528, 0.21289894, 0.15035629, 0.07864882, 0.02467073,
    -0.00106799, -0.00620177, -0.00588043,
  ],
  a: [1.0],
};
