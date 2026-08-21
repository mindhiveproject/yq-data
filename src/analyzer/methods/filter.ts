/**
 * Digital filtering.
 *
 * Two layers live here: a general difference-equation filter (`lfilter` /
 * `filtfilt`, matching the SciPy semantics the reference implementation was
 * written against), and Butterworth biquad design so callers can ask for
 * "bandpass 1–40 Hz" instead of supplying coefficients.
 */

/** Numerator (`b`) and denominator (`a`) coefficients of a filter. */
export interface FilterCoefficients {
  b: number[];
  a: number[];
}

export type FilterKind = "lowpass" | "highpass" | "bandpass" | "bandstop";

/**
 * A biquad section as normalized difference-equation coefficients.
 *
 * Sections are cascaded rather than expanded into one high-order polynomial:
 * a single high-order difference equation is numerically fragile, while a
 * cascade of second-order sections is the standard stable form.
 */
export type Biquad = FilterCoefficients;

function normalize(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number
): Biquad {
  return {
    b: [b0 / a0, b1 / a0, b2 / a0],
    a: [1, a1 / a0, a2 / a0],
  };
}

/**
 * Q factors of the second-order sections of a Butterworth filter.
 *
 * An order-N Butterworth has N/2 conjugate pole pairs spaced evenly around a
 * semicircle; each pair becomes one section with its own Q. Cascading
 * identical sections instead — a common shortcut — gives a much softer
 * rolloff than the requested order.
 */
function butterworthQs(order: number): number[] {
  const sections = Math.max(1, Math.round(order / 2));
  const n = sections * 2;
  const qs: number[] = [];
  for (let k = 0; k < sections; k++) {
    qs.push(1 / (2 * Math.sin((Math.PI * (2 * k + 1)) / (2 * n))));
  }
  return qs;
}

/** Designs one RBJ-cookbook biquad. */
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

  switch (kind) {
    case "lowpass":
      return normalize(
        (1 - cos) / 2,
        1 - cos,
        (1 - cos) / 2,
        1 + alpha,
        -2 * cos,
        1 - alpha
      );
    case "highpass":
      return normalize(
        (1 + cos) / 2,
        -(1 + cos),
        (1 + cos) / 2,
        1 + alpha,
        -2 * cos,
        1 - alpha
      );
    case "bandpass": {
      // Constant 0 dB peak gain form.
      const a = bandwidth !== undefined ? sin / (2 * (frequency / bandwidth)) : alpha;
      return normalize(a, 0, -a, 1 + a, -2 * cos, 1 - a);
    }
    case "bandstop": {
      const a = bandwidth !== undefined ? sin / (2 * (frequency / bandwidth)) : alpha;
      return normalize(1, -2 * cos, 1, 1 + a, -2 * cos, 1 - a);
    }
  }
}

export interface FilterDesign {
  kind: FilterKind;
  /** Cutoff in Hz. For bandpass/bandstop, `[low, high]`. */
  cutoff: number | [number, number];
  samplingRate: number;
  /** Filter order. Rounded up to an even number of biquad sections. */
  order?: number;
}

/**
 * Designs a Butterworth filter as a cascade of biquad sections.
 *
 * Band filters are realised at the geometric-mean centre frequency with a Q
 * set by the requested bandwidth, which is the standard bilinear-transform
 * treatment for a bandpass biquad.
 */
export function designFilter(design: FilterDesign): Biquad[] {
  const { kind, cutoff, samplingRate, order = 2 } = design;
  const nyquist = samplingRate / 2;

  if (kind === "bandpass" || kind === "bandstop") {
    const [low, high] = cutoff as [number, number];
    const lo = Math.max(1e-6, Math.min(low, nyquist * 0.999));
    const hi = Math.max(lo + 1e-6, Math.min(high, nyquist * 0.999));
    const centre = Math.sqrt(lo * hi);
    const bandwidth = hi - lo;
    return butterworthQs(order).map(() =>
      designBiquad(kind, centre, samplingRate, centre / bandwidth, bandwidth)
    );
  }

  const f = Math.max(1e-6, Math.min(cutoff as number, nyquist * 0.999));
  return butterworthQs(order).map((q) =>
    designBiquad(kind, f, samplingRate, q)
  );
}

/**
 * Applies a difference equation in the forward direction.
 *
 * `y[n] = b0*x[n] + ... + bM*x[n-M] - a1*y[n-1] - ... - aN*y[n-N]`
 *
 * Optional `state` carries the tail of the previous block, so a stream can be
 * filtered chunk-by-chunk without a discontinuity at every packet boundary.
 */
export function lfilter(
  b: ArrayLike<number>,
  a: ArrayLike<number>,
  x: ArrayLike<number>,
  state?: { x: number[]; y: number[] }
): Float32Array {
  const y = new Float32Array(x.length);
  const a0 = a[0] || 1;

  const priorX = state?.x ?? [];
  const priorY = state?.y ?? [];

  const xAt = (i: number) => (i >= 0 ? x[i] : priorX[priorX.length + i] ?? 0);
  const yAt = (i: number) => (i >= 0 ? y[i] : priorY[priorY.length + i] ?? 0);

  for (let n = 0; n < x.length; n++) {
    let acc = 0;
    for (let j = 0; j < b.length; j++) acc += (b[j] / a0) * xAt(n - j);
    for (let j = 1; j < a.length; j++) acc -= (a[j] / a0) * yAt(n - j);
    y[n] = acc;
  }

  if (state) {
    const keepX = Math.max(0, b.length - 1);
    const keepY = Math.max(0, a.length - 1);
    const allX = [...priorX, ...Array.from(x)];
    const allY = [...priorY, ...Array.from(y)];
    state.x = allX.slice(allX.length - keepX);
    state.y = allY.slice(allY.length - keepY);
  }

  return y;
}

/** Runs a signal through a cascade of biquad sections. */
export function applyCascade(
  sections: Biquad[],
  x: ArrayLike<number>,
  states?: Array<{ x: number[]; y: number[] }>
): Float32Array {
  let signal: ArrayLike<number> = x;
  sections.forEach((section, i) => {
    signal = lfilter(section.b, section.a, signal, states?.[i]);
  });
  return signal instanceof Float32Array
    ? signal
    : Float32Array.from(signal as ArrayLike<number>);
}

/**
 * Zero-phase filtering: forward, then backward.
 *
 * Squares the magnitude response but cancels phase distortion entirely, which
 * matters when the *timing* of a feature is the measurement — peak positions
 * in a PPG pulse, for instance. Edges are padded by odd reflection to keep the
 * filter's transient out of the result.
 */
export function filtfilt(
  b: ArrayLike<number>,
  a: ArrayLike<number>,
  x: ArrayLike<number>,
  padType: "odd" | "constant" | "none" = "odd"
): Float32Array {
  const padLength = Math.min(
    3 * Math.max(a.length, b.length),
    Math.max(0, x.length - 1)
  );

  let padded: number[];
  if (padLength > 0 && padType !== "none") {
    const first = x[0];
    const last = x[x.length - 1];
    const left: number[] = [];
    const right: number[] = [];

    for (let i = padLength; i >= 1; i--) {
      left.push(padType === "odd" ? 2 * first - x[i] : first);
    }
    for (let i = x.length - 2; i >= x.length - 1 - padLength; i--) {
      right.push(padType === "odd" ? 2 * last - x[i] : last);
    }
    padded = [...left, ...Array.from(x), ...right];
  } else {
    padded = Array.from(x);
  }

  const forward = lfilter(b, a, padded);
  const reversed = Array.from(forward).reverse();
  const backward = lfilter(b, a, reversed);
  const restored = Array.from(backward).reverse();

  const start = padLength > 0 && padType !== "none" ? padLength : 0;
  return Float32Array.from(restored.slice(start, start + x.length));
}

/** Zero-phase filtering through a designed cascade. */
export function filtfiltCascade(
  sections: Biquad[],
  x: ArrayLike<number>
): Float32Array {
  let signal: ArrayLike<number> = x;
  for (const section of sections) {
    signal = filtfilt(section.b, section.a, signal);
  }
  return Float32Array.from(signal as ArrayLike<number>);
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
