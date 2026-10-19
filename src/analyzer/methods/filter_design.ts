/**
 * Filter design, following SciPy.
 *
 * `butter` and `firwin` are ports of `scipy.signal.butter` and
 * `scipy.signal.firwin`, step for step, so that a filter designed here has the
 * same coefficients as the one a researcher gets from SciPy (or MNE, which
 * calls it) and results carry over. The names follow SciPy, and so do the
 * conventions: `order` is the `N` passed to `butter`, which makes a band filter
 * of order N a 2N-pole system.
 *
 * The IIR path is SciPy's: an analog prototype (`buttap`), a frequency
 * transform to the requested band (`lp2lp`/`lp2hp`/`lp2bp`/`lp2bs`), the
 * bilinear transform with prewarping, then pairing of the poles and zeros into
 * second-order sections (`zpk2sos`). Everything is done in float64.
 */

import { WindowSpec, windowFunction } from "./window";

/** Numerator (`b`) and denominator (`a`) coefficients of a filter. */
export interface FilterCoefficients {
  b: number[];
  a: number[];
}

export type FilterKind = "lowpass" | "highpass" | "bandpass" | "bandstop";

/**
 * A second-order section as difference-equation coefficients (`a[0] = 1`).
 *
 * Sections are cascaded rather than expanded into one high-order polynomial:
 * a single high-order difference equation is numerically fragile (SciPy's
 * documentation steers everyone to `sos` for the same reason), while a cascade
 * of second-order sections is the standard stable form.
 */
export type Biquad = FilterCoefficients;

export interface Complex {
  re: number;
  im: number;
}

/** Zeros, poles and gain of a transfer function. */
export interface Zpk {
  z: Complex[];
  p: Complex[];
  k: number;
}

// ---------------------------------------------------------------------------
// Complex arithmetic (just what the design needs)

const cx = (re: number, im = 0): Complex => ({ re, im });
const add = (a: Complex, b: Complex): Complex => cx(a.re + b.re, a.im + b.im);
const sub = (a: Complex, b: Complex): Complex => cx(a.re - b.re, a.im - b.im);
const mul = (a: Complex, b: Complex): Complex =>
  cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const scale = (a: Complex, s: number): Complex => cx(a.re * s, a.im * s);
const conj = (a: Complex): Complex => cx(a.re, -a.im);
const abs = (a: Complex): number => Math.hypot(a.re, a.im);
const div = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
/** Principal square root, as C99 `csqrt` / NumPy. */
function sqrt(a: Complex): Complex {
  const r = abs(a);
  if (r === 0) return cx(0, 0);
  const t = Math.sqrt((r + Math.abs(a.re)) / 2);
  return a.re >= 0 ? cx(t, a.im / (2 * t)) : cx(Math.abs(a.im) / (2 * t), a.im < 0 ? -t : t);
}
const prod = (xs: Complex[]): Complex => xs.reduce((acc, x) => mul(acc, x), cx(1));
const isReal = (a: Complex) => a.im === 0;

/** Coefficients of the monic polynomial with the given roots (`numpy.poly`). */
function poly(roots: Complex[]): Complex[] {
  let coefficients: Complex[] = [cx(1)];
  for (const root of roots) {
    const next: Complex[] = [...coefficients, cx(0)];
    for (let i = 1; i < next.length; i++) {
      next[i] = sub(next[i], mul(root, coefficients[i - 1]));
    }
    coefficients = next;
  }
  return coefficients;
}

/** Transfer function from zeros, poles and gain (`scipy.signal.zpk2tf`). */
export function zpk2tf({ z, p, k }: Zpk): FilterCoefficients {
  return {
    b: poly(z).map((c) => c.re * k),
    a: poly(p).map((c) => c.re),
  };
}

// ---------------------------------------------------------------------------
// Analog prototype and frequency transforms (all in the zpk domain)

/** Analog Butterworth lowpass prototype with unit cutoff (`scipy.signal.buttap`). */
function buttap(order: number): Zpk {
  const p: Complex[] = [];
  for (let m = -order + 1; m < order; m += 2) {
    const theta = (Math.PI * m) / (2 * order);
    p.push(cx(-Math.cos(theta), -Math.sin(theta)));
  }
  return { z: [], p, k: 1 };
}

/** Real part of `prod(-a) / prod(-b)`. */
const gainRatio = (a: Complex[], b: Complex[]) =>
  div(prod(a.map((x) => scale(x, -1))), prod(b.map((x) => scale(x, -1)))).re;

const zeros = (n: number): Complex[] => Array.from({ length: n }, () => cx(0));

function lp2lp({ z, p, k }: Zpk, wo: number): Zpk {
  const degree = p.length - z.length;
  return { z: z.map((x) => scale(x, wo)), p: p.map((x) => scale(x, wo)), k: k * wo ** degree };
}

function lp2hp({ z, p, k }: Zpk, wo: number): Zpk {
  const degree = p.length - z.length;
  const inv = (x: Complex) => div(cx(wo), x);
  return {
    z: [...z.map(inv), ...zeros(degree)],
    p: p.map(inv),
    k: k * gainRatio(z, p),
  };
}

function lp2bp({ z, p, k }: Zpk, wo: number, bw: number): Zpk {
  const degree = p.length - z.length;
  const split = (roots: Complex[]) => {
    const low = roots.map((x) => scale(x, bw / 2));
    const root = low.map((x) => sqrt(sub(mul(x, x), cx(wo * wo))));
    return [...low.map((x, i) => add(x, root[i])), ...low.map((x, i) => sub(x, root[i]))];
  };
  return { z: [...split(z), ...zeros(degree)], p: split(p), k: k * bw ** degree };
}

function lp2bs({ z, p, k }: Zpk, wo: number, bw: number): Zpk {
  const degree = p.length - z.length;
  const split = (roots: Complex[]) => {
    const high = roots.map((x) => div(cx(bw / 2), x));
    const root = high.map((x) => sqrt(sub(mul(x, x), cx(wo * wo))));
    return [...high.map((x, i) => add(x, root[i])), ...high.map((x, i) => sub(x, root[i]))];
  };
  const notch: Complex[] = [];
  for (let i = 0; i < degree; i++) notch.push(cx(0, wo), cx(0, -wo));
  return { z: [...split(z), ...notch], p: split(p), k: k * gainRatio(z, p) };
}

/** Bilinear transform with `fs = 2` (`scipy.signal.bilinear_zpk`). */
function bilinear({ z, p, k }: Zpk): Zpk {
  const degree = p.length - z.length;
  const fs2 = 4;
  const map = (x: Complex) => div(add(cx(fs2), x), sub(cx(fs2), x));
  const num = prod(z.map((x) => sub(cx(fs2), x)));
  const den = prod(p.map((x) => sub(cx(fs2), x)));
  return {
    z: [...z.map(map), ...Array.from({ length: degree }, () => cx(-1))],
    p: p.map(map),
    k: k * div(num, den).re,
  };
}

// ---------------------------------------------------------------------------
// zpk -> second-order sections (port of scipy.signal.zpk2sos, 'nearest' pairing)

const EPS = 2.220446049250313e-16;

/**
 * Splits into complex and real parts, merging each conjugate pair into the
 * member with positive imaginary part (`scipy.signal._cplxreal`).
 */
function cplxreal(input: Complex[], tol = 100 * EPS): { zc: Complex[]; zr: Complex[] } {
  if (input.length === 0) return { zc: [], zr: [] };
  const sorted = [...input].sort((a, b) => a.re - b.re || Math.abs(a.im) - Math.abs(b.im));
  const isRealish = (c: Complex) => Math.abs(c.im) <= tol * abs(c);
  const zr = sorted.filter(isRealish).map((c) => cx(c.re));
  const rest = sorted.filter((c) => !isRealish(c));
  if (rest.length === 0) return { zc: [], zr };

  const zp = rest.filter((c) => c.im > 0);
  const zn = rest.filter((c) => c.im < 0);
  if (zp.length !== zn.length) {
    throw new Error("Array contains complex value with no matching conjugate.");
  }

  // Within a run of (nearly) equal real parts, order by imaginary magnitude.
  let start = 0;
  for (let i = 0; i <= zp.length; i++) {
    const continues = i < zp.length - 1 && zp[i + 1].re - zp[i].re <= tol * abs(zp[i]);
    if (!continues) {
      for (const chunk of [zp, zn]) {
        const sortedChunk = chunk.slice(start, i + 1).sort((a, b) => Math.abs(a.im) - Math.abs(b.im));
        chunk.splice(start, sortedChunk.length, ...sortedChunk);
      }
      start = i + 1;
    }
  }

  const zc = zp.map((c, i) => {
    if (abs(sub(c, conj(zn[i]))) > tol * abs(zn[i])) {
      throw new Error("Array contains complex value with no matching conjugate.");
    }
    return scale(add(c, conj(zn[i])), 0.5);
  });
  return { zc, zr };
}

const withoutIndex = <T>(xs: T[], index: number): T[] => xs.filter((_, i) => i !== index);

/** Index of the entry of `from` nearest `to`, restricted to real/complex/any. */
function nearestIndex(from: Complex[], to: Complex, which: "real" | "complex" | "any"): number {
  const order = from
    .map((c, i) => ({ i, d: abs(sub(c, to)) }))
    .sort((a, b) => a.d - b.d || a.i - b.i);
  if (which === "any") return order[0].i;
  const match = order.find(({ i }) => isReal(from[i]) === (which === "real"));
  return match!.i;
}

function singleSection(z: Complex[], p: Complex[]): Biquad {
  const num = poly(z).map((c) => c.re);
  const den = poly(p).map((c) => c.re);
  const pad = (c: number[]) => [...new Array(3 - c.length).fill(0), ...c];
  return { b: pad(num), a: pad(den) };
}

/**
 * Pairs poles and zeros into second-order sections the way
 * `scipy.signal.zpk2sos` does by default (`pairing='nearest'`): the pole
 * closest to the unit circle is paired with the zeros nearest to it, and the
 * sections are ordered so the least stable one runs last.
 */
export function zpk2sos({ z: zeros_, p: poles, k }: Zpk): Biquad[] {
  if (zeros_.length === 0 && poles.length === 0) return [{ b: [k, 0, 0], a: [1, 0, 0] }];

  let p = [...poles, ...zeros(Math.max(zeros_.length - poles.length, 0))];
  let z = [...zeros_, ...zeros(Math.max(poles.length - zeros_.length, 0))];
  const sections = Math.floor((Math.max(p.length, z.length) + 1) / 2);
  if (p.length % 2 === 1) {
    p = [...p, cx(0)];
    z = [...z, cx(0)];
  }

  const split = (roots: Complex[]) => {
    const { zc, zr } = cplxreal(roots);
    return [...zc, ...zr];
  };
  z = split(z);
  p = split(p);

  const worst = (xs: Complex[]) => {
    let best = 0;
    for (let i = 1; i < xs.length; i++) {
      if (Math.abs(1 - abs(xs[i])) < Math.abs(1 - abs(xs[best]))) best = i;
    }
    return best;
  };
  const realCount = (xs: Complex[]) => xs.filter(isReal).length;

  const out: Biquad[] = new Array(sections);
  for (let si = sections - 1; si >= 0; si--) {
    const p1Index = worst(p);
    const p1 = p[p1Index];
    p = withoutIndex(p, p1Index);

    if (isReal(p1) && realCount(p) === 0) {
      // Last real pole: pair with the nearest real zero.
      const z1Index = nearestIndex(z, p1, "real");
      const z1 = z[z1Index];
      z = withoutIndex(z, z1Index);
      out[si] = singleSection([z1, cx(0)], [p1, cx(0)]);
    } else if (
      p.length + 1 === z.length &&
      !isReal(p1) &&
      realCount(p) === 1 &&
      realCount(z) === 1
    ) {
      // One real pole left over alongside a complex one: take a complex zero pair.
      const z1Index = nearestIndex(z, p1, "complex");
      const z1 = z[z1Index];
      z = withoutIndex(z, z1Index);
      out[si] = singleSection([z1, conj(z1)], [p1, conj(p1)]);
    } else {
      let p2: Complex;
      if (isReal(p1)) {
        const realIdx = p.map((c, i) => (isReal(c) ? i : -1)).filter((i) => i >= 0);
        const p2Index = realIdx[worst(realIdx.map((i) => p[i]))];
        p2 = p[p2Index];
        p = withoutIndex(p, p2Index);
      } else {
        p2 = conj(p1);
      }

      if (z.length > 0) {
        const z1Index = nearestIndex(z, p1, "any");
        const z1 = z[z1Index];
        z = withoutIndex(z, z1Index);
        if (!isReal(z1)) {
          out[si] = singleSection([z1, conj(z1)], [p1, p2]);
        } else {
          const z2Index = nearestIndex(z, p1, "real");
          const z2 = z[z2Index];
          z = withoutIndex(z, z2Index);
          out[si] = singleSection([z1, z2], [p1, p2]);
        }
      } else {
        out[si] = singleSection([], [p1, p2]);
      }
    }
  }

  out[0] = { b: out[0].b.map((c) => c * k), a: out[0].a };
  return out;
}

// ---------------------------------------------------------------------------
// Butterworth

export interface ButterOptions {
  /** `'lowpass'` (default), `'highpass'`, `'bandpass'` or `'bandstop'`. */
  btype?: FilterKind;
  /** Sampling rate in Hz. Without it, cutoffs are normalised to Nyquist = 1. */
  fs?: number;
  /** `'ba'` (default, as in SciPy), `'sos'` (recommended) or `'zpk'`. */
  output?: "ba" | "sos" | "zpk";
}

/**
 * Digital Butterworth filter (`scipy.signal.butter`).
 *
 * `order` is SciPy's `N`: the order of the lowpass prototype. Lowpass and
 * highpass filters have N poles; bandpass and bandstop filters have 2N, so
 * `butter(4, [1, 40], { btype: "bandpass", fs })` is an eighth-order system.
 *
 * The `'ba'` form loses precision above roughly order 8 (or at narrow
 * bandwidths relative to the sampling rate); use `output: "sos"` for anything
 * serious. `fs` defaults to 2, i.e. cutoffs are fractions of Nyquist.
 */
export function butter(
  order: number,
  cutoff: number | [number, number],
  options: ButterOptions & { output: "sos" }
): Biquad[];
export function butter(
  order: number,
  cutoff: number | [number, number],
  options: ButterOptions & { output: "zpk" }
): Zpk;
export function butter(
  order: number,
  cutoff: number | [number, number],
  options?: ButterOptions & { output?: "ba" }
): FilterCoefficients;
export function butter(
  order: number,
  cutoff: number | [number, number],
  options: ButterOptions = {}
): FilterCoefficients | Biquad[] | Zpk {
  const { fs = 2, output = "ba" } = options;
  const btype = options.btype ?? "lowpass";
  const isBand = btype === "bandpass" || btype === "bandstop";

  if (!Number.isInteger(order) || order < 1) {
    throw new RangeError(`Filter order must be a positive integer, got ${order}.`);
  }
  if (!(fs > 0)) throw new RangeError(`Sampling rate must be positive, got ${fs}.`);
  const edges = Array.isArray(cutoff) ? cutoff : [cutoff];
  if (edges.length !== (isBand ? 2 : 1)) {
    throw new RangeError(
      isBand
        ? `A ${btype} filter needs [low, high] cutoffs.`
        : `A ${btype} filter needs a single cutoff.`
    );
  }
  const nyquist = fs / 2;
  for (const edge of edges) {
    if (!(edge > 0 && edge < nyquist)) {
      throw new RangeError(
        `Cutoff ${edge} Hz is outside (0, ${nyquist}) Hz, the range for a ${fs} Hz sampling rate.`
      );
    }
  }
  if (isBand && !(edges[0] < edges[1])) {
    throw new RangeError(`Band cutoffs must be ascending, got [${edges[0]}, ${edges[1]}].`);
  }

  // Prewarp the digital edges to analog frequencies so the bilinear transform
  // lands the -3 dB points exactly on them.
  const warped = edges.map((f) => 4 * Math.tan((Math.PI * (f / nyquist)) / 2));
  const prototype = buttap(order);

  let analog: Zpk;
  switch (btype) {
    case "lowpass":
      analog = lp2lp(prototype, warped[0]);
      break;
    case "highpass":
      analog = lp2hp(prototype, warped[0]);
      break;
    case "bandpass":
    case "bandstop": {
      const bw = warped[1] - warped[0];
      const wo = Math.sqrt(warped[0] * warped[1]);
      analog = (btype === "bandpass" ? lp2bp : lp2bs)(prototype, wo, bw);
      break;
    }
    default:
      throw new Error(`Unknown filter type "${String(btype)}".`);
  }

  const digital = bilinear(analog);
  if (output === "zpk") return digital;
  if (output === "sos") return zpk2sos(digital);
  return zpk2tf(digital);
}

export interface FilterDesign {
  kind: FilterKind;
  /** Cutoff in Hz. For bandpass/bandstop, `[low, high]`. */
  cutoff: number | [number, number];
  samplingRate: number;
  /**
   * Butterworth order, as the `N` of `scipy.signal.butter`: band filters have
   * twice as many poles.
   */
  order?: number;
}

/** A Butterworth filter as second-order sections, from named parameters. */
export function designFilter(design: FilterDesign): Biquad[] {
  const { kind, cutoff, samplingRate, order = 2 } = design;
  return butter(order, cutoff, { btype: kind, fs: samplingRate, output: "sos" });
}

/** Sections as SciPy's `sos` matrix: rows of `[b0, b1, b2, a0, a1, a2]`. */
export const toSosMatrix = (sections: Biquad[]): number[][] =>
  sections.map((s) => [...s.b, ...s.a]);

/** The inverse of `toSosMatrix`. */
export const fromSosMatrix = (sos: ArrayLike<number>[]): Biquad[] =>
  sos.map((row) => ({ b: [row[0], row[1], row[2]], a: [row[3], row[4], row[5]] }));

// ---------------------------------------------------------------------------
// FIR design by the window method

/** Attenuation in dB of a Kaiser-window FIR of `numtaps` and transition `width` (`kaiser_atten`). */
export function kaiserAtten(numtaps: number, width: number): number {
  return 2.285 * (numtaps - 1) * Math.PI * width + 7.95;
}

/** Kaiser `beta` for a stop-band attenuation in dB (`kaiser_beta`). */
export function kaiserBeta(attenuation: number): number {
  if (attenuation > 50) return 0.1102 * (attenuation - 8.7);
  if (attenuation > 21) return 0.5842 * (attenuation - 21) ** 0.4 + 0.07886 * (attenuation - 21);
  return 0;
}

/**
 * Length and `beta` of the Kaiser-window FIR meeting a ripple (dB) and
 * transition width (fraction of Nyquist) specification (`scipy.signal.kaiserord`).
 */
export function kaiserord(ripple: number, width: number): { numtaps: number; beta: number } {
  const a = Math.abs(ripple);
  if (a < 8) throw new RangeError("Requested maximum ripple attenuation is too small for the Kaiser formula.");
  return {
    numtaps: Math.ceil((a - 7.95) / 2.285 / (Math.PI * width)) + 1,
    beta: kaiserBeta(a),
  };
}

export interface FirwinOptions {
  /**
   * Window applied to the ideal (sinc) impulse response. A name, or
   * `[name, parameter]` as in `scipy.signal.get_window`; see `WindowSpec`.
   * Default `'hamming'`, as in SciPy.
   */
  window?: WindowSpec;
  /**
   * Which bands pass. SciPy's `pass_zero`: `true` / `'lowpass'` /
   * `'bandstop'` pass DC; `false` / `'highpass'` / `'bandpass'` do not. A name
   * is checked against the number of cutoffs. Default `true`.
   */
  passZero?: boolean | FilterKind;
  /** Scale the taps to unit gain at the centre of the first passband. Default `true`. */
  scale?: boolean;
  /** Sampling rate in Hz; cutoffs are then in Hz. Default 2 (Nyquist = 1). */
  fs?: number;
  /**
   * Approximate transition width (same units as `fs`). When given, the window
   * is a Kaiser window sized for it and `window` is ignored.
   */
  width?: number;
}

/**
 * FIR filter design by the window method (`scipy.signal.firwin`).
 *
 * The ideal brick-wall impulse response, a sum of sincs, is truncated to
 * `numtaps` samples by multiplying with a window. The window sets the trade-off
 * between transition width (narrow with `boxcar`/`hamming`) and stop-band
 * attenuation (deep with `blackman`/`kaiser`).
 *
 * The result is linear-phase: a constant delay of `(numtaps - 1) / 2` samples.
 */
export function firwin(
  numtaps: number,
  cutoff: number | number[],
  options: FirwinOptions = {}
): number[] {
  const { scale: doScale = true, fs = 2 } = options;
  let { window = "hamming" } = options;

  if (!Number.isInteger(numtaps) || numtaps < 1) {
    throw new RangeError(`numtaps must be a positive integer, got ${numtaps}.`);
  }
  const nyquist = fs / 2;
  const edges = (Array.isArray(cutoff) ? cutoff : [cutoff]).map((f) => f / nyquist);
  if (edges.length === 0) throw new RangeError("At least one cutoff frequency must be given.");
  if (edges.some((f) => !(f > 0 && f < 1))) {
    throw new RangeError(`Cutoff frequencies must be within (0, ${nyquist}) for fs = ${fs}.`);
  }
  if (edges.some((f, i) => i > 0 && f <= edges[i - 1])) {
    throw new RangeError("Cutoff frequencies must be strictly increasing.");
  }

  if (options.width !== undefined) {
    window = ["kaiser", kaiserBeta(kaiserAtten(numtaps, options.width / nyquist))];
  }

  let passZero: boolean;
  const named = options.passZero;
  if (typeof named === "string") {
    const bandCount = edges.length;
    const expected = bandCount === 1 ? ["lowpass", "highpass"] : ["bandpass", "bandstop"];
    if (!expected.includes(named)) {
      throw new RangeError(`passZero "${named}" does not fit ${bandCount} cutoff(s).`);
    }
    passZero = named === "lowpass" || named === "bandstop";
  } else {
    passZero = named ?? true;
  }

  const passNyquist = (edges.length % 2 === 1) !== passZero;
  if (passNyquist && numtaps % 2 === 0) {
    throw new RangeError(
      "A filter with an even number of taps must have zero response at the Nyquist " +
        "frequency; use an odd numtaps for highpass and bandstop filters."
    );
  }

  const boundaries = [...(passZero ? [0] : []), ...edges, ...(passNyquist ? [1] : [])];
  const bands: Array<[number, number]> = [];
  for (let i = 0; i < boundaries.length; i += 2) bands.push([boundaries[i], boundaries[i + 1]]);

  const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const alpha = 0.5 * (numtaps - 1);
  const win = windowFunction(window, numtaps, true);
  const h: number[] = [];
  for (let n = 0; n < numtaps; n++) {
    const m = n - alpha;
    let v = 0;
    for (const [left, right] of bands) v += right * sinc(right * m) - left * sinc(left * m);
    h.push(v * win[n]);
  }

  if (doScale) {
    const [left, right] = bands[0];
    const frequency = left === 0 ? 0 : right === 1 ? 1 : 0.5 * (left + right);
    let gain = 0;
    for (let n = 0; n < numtaps; n++) gain += h[n] * Math.cos(Math.PI * (n - alpha) * frequency);
    for (let n = 0; n < numtaps; n++) h[n] /= gain;
  }
  return h;
}

// ---------------------------------------------------------------------------
// RBJ cookbook biquad

/**
 * One biquad from Robert Bristow-Johnson's Audio EQ Cookbook.
 *
 * Not a SciPy design: a cookbook band filter is a *resonator* with the given
 * Q, not a Butterworth band filter. It is kept for second-order notch and
 * peak shapes; use `butter` / `designFilter` for anything that should match
 * SciPy.
 */
export function designBiquad(
  kind: FilterKind,
  frequency: number,
  samplingRate: number,
  q: number,
  bandwidth?: number
): Biquad {
  const w0 = (2 * Math.PI * frequency) / samplingRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const normalize = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad => ({
    b: [b0 / a0, b1 / a0, b2 / a0],
    a: [1, a1 / a0, a2 / a0],
  });

  switch (kind) {
    case "lowpass":
      return normalize((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    case "highpass":
      return normalize((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
    case "bandpass": {
      const a = bandwidth !== undefined ? sin / (2 * (frequency / bandwidth)) : alpha;
      return normalize(a, 0, -a, 1 + a, -2 * cos, 1 - a);
    }
    case "bandstop": {
      const a = bandwidth !== undefined ? sin / (2 * (frequency / bandwidth)) : alpha;
      return normalize(1, -2 * cos, 1, 1 + a, -2 * cos, 1 - a);
    }
  }
}
