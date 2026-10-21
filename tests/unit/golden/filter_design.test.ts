/**
 * Golden-value tests: filter design and application at the coefficient level,
 * against SciPy.
 *
 * Fixtures (see `ref_filter.py`):
 *   `filter_butter.json`    butter(N=1..8) for each filter type: sos, zpk, ba
 *   `filter_fir.json`       firwin over windows, pass_zero forms, width=; kaiserord
 *   `window_functions.json` get_window, symmetric and periodic
 *   `filter_extras.json`    lfilter_zi, sosfilt_zi, lfilter/sosfilt with zi,
 *                           filtfilt/sosfiltfilt over pad types and padlen
 *
 * These are conformance tests: the package ports SciPy's algorithms, so the
 * numbers must agree to float64 rounding, not to a stated engineering
 * tolerance.
 */
import "./allclose";
import {
  Biquad,
  Complex,
  Filtering,
  WindowSpec,
  butter,
  filtfilt,
  firwin,
  fromSosMatrix,
  kaiserord,
  lfilter,
  lfilterZi,
  sosfilt,
  sosfiltZi,
  sosfiltfilt,
  toSosMatrix,
  windowFunction,
} from "../../../src";
import { channelsOf, fixture, inputs, maxAbsDiff, packetStream, rmsOf } from "./harness";


type FilterKind = "lowpass" | "highpass" | "bandpass" | "bandstop";

const butterFx = fixture<{
  cases: {
    id: string;
    kind: FilterKind;
    cutoff: number | [number, number];
    samplingRate: number;
    order: number;
    sos: number[][];
    zpk: { z: number[][]; p: number[][]; k: number };
    ba?: { b: number[]; a: number[] };
  }[];
}>("filter_butter");

const firFx = fixture<{
  cases: {
    id: string;
    numtaps: number;
    cutoff: number | number[];
    fs: number;
    options: {
      window?: WindowSpec | null;
      passZero?: boolean | FilterKind;
      scale?: boolean;
      width?: number;
    };
    taps: number[];
  }[];
  kaiserord: { ripple: number; width: number; numtaps: number; beta: number }[];
}>("filter_fir");

const windowFx = fixture<{
  cases: { id: string; spec: WindowSpec; length: number; symmetric: boolean; window: number[] }[];
}>("window_functions");

const extras = fixture<{
  samples: number;
  lfilterZi: { id: string; b: number[]; a: number[]; zi: number[] }[];
  sosfiltZi: { id: string; sos: number[][]; zi: number[][] }[];
  lfilterWithZi: { signal: string; b: number[]; a: number[]; zi: number[]; output: number[]; zf: number[] };
  sosfiltWithZi: { signal: string; sos: number[][]; zi: number[][]; output: number[]; zf: number[][] };
  padCases: {
    id: string;
    form: "ba" | "sos" | "fir";
    signal: string;
    padtype: "odd" | "even" | "constant" | null;
    padlen: number | null;
    b?: number[];
    a?: number[];
    sections?: Biquad[];
    scipy: number[];
  }[];
}>("filter_extras");

/** Compares root sets without caring about order. */
function expectSameRoots(actual: Complex[], expected: number[][]) {
  expect(actual.length).toBe(expected.length);
  const remaining = [...actual];
  for (const [re, im] of expected) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      const d = Math.hypot(remaining[i].re - re, remaining[i].im - im);
      if (d < Math.hypot(remaining[best].re - re, remaining[best].im - im)) best = i;
    }
    const found = remaining.splice(best, 1)[0];
    expect(Math.hypot(found.re - re, found.im - im)).toBeLessThan(1e-9 * (1 + Math.hypot(re, im)));
  }
}

describe("golden: butter() vs scipy.signal.butter, coefficient for coefficient", () => {
  type Case = (typeof butterFx.cases)[number];
  const options = (c: Case) => ({ btype: c.kind, fs: c.samplingRate });
  const asSos = (c: Case) => butter(c.order, c.cutoff, { ...options(c), output: "sos" });
  const asZpk = (c: Case) => butter(c.order, c.cutoff, { ...options(c), output: "zpk" });
  const asBa = (c: Case) => butter(c.order, c.cutoff, options(c));

  it.each(butterFx.cases)("$id: sos, in SciPy's section order", (c) => {
    const sos = toSosMatrix(asSos(c));
    expect(sos.length).toBe(c.sos.length);
    sos.forEach((row, i) => expect(row).toBeAllClose(c.sos[i], { rtol: 1e-9, atol: 1e-12 }));
  });

  it.each(butterFx.cases)("$id: zeros, poles and gain", (c) => {
    const { z, p, k } = asZpk(c);
    expectSameRoots(z, c.zpk.z);
    expectSameRoots(p, c.zpk.p);
    expect(k).toBeCloseTo(c.zpk.k, 12);
    expect(Math.abs(k - c.zpk.k)).toBeLessThanOrEqual(1e-9 * Math.abs(c.zpk.k));
  });

  // Order <= 4 only: above that the ba form is too ill-conditioned for two
  // implementations to agree beyond a few digits -- SciPy warns about it too.
  const withBa = butterFx.cases.filter((c) => c.ba);
  it.each(withBa)("$id: ba", (c) => {
    const { b, a } = asBa(c);
    const scaleB = Math.max(...c.ba!.b.map(Math.abs));
    const scaleA = Math.max(...c.ba!.a.map(Math.abs));
    expect(b).toBeAllClose(c.ba!.b, { rtol: 0, atol: 1e-9 * scaleB });
    expect(a).toBeAllClose(c.ba!.a, { rtol: 0, atol: 1e-9 * scaleA });
  });

  it("sos matrices round-trip", () => {
    const sos = butterFx.cases[0].sos;
    expect(toSosMatrix(fromSosMatrix(sos))).toEqual(sos);
  });

  describe("rejects what SciPy rejects", () => {
    it.each([
      ["order 0", () => butter(0, 10, { fs: 100 })],
      ["fractional order", () => butter(2.5, 10, { fs: 100 })],
      ["cutoff at Nyquist", () => butter(2, 50, { fs: 100 })],
      ["cutoff above Nyquist", () => butter(2, 60, { fs: 100 })],
      ["zero cutoff", () => butter(2, 0, { fs: 100 })],
      ["descending band", () => butter(2, [20, 10], { btype: "bandpass", fs: 100 })],
      ["one edge for a band", () => butter(2, 10, { btype: "bandpass", fs: 100 })],
      ["two edges for a lowpass", () => butter(2, [10, 20], { fs: 100 })],
    ])("%s", (_, make) => {
      expect(make).toThrow(RangeError);
    });
  });
});

describe("golden: window functions vs scipy.signal.get_window", () => {
  it.each(windowFx.cases)("$id", (c) => {
    const w = windowFunction(c.spec, c.length, c.symmetric);
    expect(w.length).toBe(c.length);
    // Same closed forms as SciPy in float64: rounding-level agreement.
    expect(w).toBeAllClose(c.window, { rtol: 1e-12, atol: 1e-14 });
  });

  it("rejects an unknown window and missing parameters", () => {
    expect(() => windowFunction("nope" as never, 8)).toThrow(/Unknown window/);
    expect(() => windowFunction("kaiser" as never, 8)).toThrow(/beta/);
    expect(() => windowFunction("gaussian" as never, 8)).toThrow(/std/);
  });
});

describe("golden: firwin vs scipy.signal.firwin", () => {
  it.each(firFx.cases)("$id", (c) => {
    const { window, ...rest } = c.options;
    const taps = firwin(c.numtaps, c.cutoff, {
      ...rest,
      fs: c.fs,
      ...(window ? { window } : {}),
    });
    expect(taps.length).toBe(c.numtaps);
    expect(taps).toBeAllClose(c.taps, { rtol: 1e-9, atol: 1e-12 });
    if (/^(lowpass|bandpass)_hamming:(blackman|hann|kaiser_8\.6)$/.test(c.id)) {
    }
  });

  it.each(firFx.kaiserord)("kaiserord($ripple dB, $width) = $numtaps taps, beta $beta", (c) => {
    const got = kaiserord(c.ripple, c.width);
    expect(got.numtaps).toBe(c.numtaps);
    expect(got.beta).toBeCloseTo(c.beta, 12);
  });

  describe("rejects what SciPy rejects", () => {
    it("even length with a response at Nyquist", () => {
      expect(() => firwin(100, 1, { fs: 256, passZero: "highpass" })).toThrow(/odd numtaps/);
    });
    it("cutoff outside (0, Nyquist)", () => {
      expect(() => firwin(51, 128, { fs: 256 })).toThrow(RangeError);
    });
    it("non-increasing cutoffs", () => {
      expect(() => firwin(51, [20, 10], { fs: 256, passZero: "bandpass" })).toThrow(RangeError);
    });
    it("a pass_zero name that does not fit the cutoffs", () => {
      expect(() => firwin(51, 10, { fs: 256, passZero: "bandpass" })).toThrow(RangeError);
    });
  });

  it("is linear phase: symmetric taps, unit gain at the passband centre", () => {
    const taps = firwin(101, [8, 12], { fs: 256, passZero: "bandpass", window: "blackman" });
    taps.forEach((t, i) => expect(t).toBeCloseTo(taps[taps.length - 1 - i], 14));
    const f = 10 / 256;
    let re = 0;
    let im = 0;
    taps.forEach((t, n) => {
      re += t * Math.cos(2 * Math.PI * f * n);
      im -= t * Math.sin(2 * Math.PI * f * n);
    });
    expect(Math.hypot(re, im)).toBeCloseTo(1, 12);
  });
});

describe("golden: initial conditions vs lfilter_zi / sosfilt_zi", () => {
  it.each(extras.lfilterZi)("lfilterZi: $id", (c) => {
    expect(lfilterZi(c.b, c.a)).toBeAllClose(c.zi, { rtol: 1e-10, atol: 1e-12 });
  });

  it.each(extras.sosfiltZi)("sosfiltZi: $id", (c) => {
    const zi = sosfiltZi(fromSosMatrix(c.sos));
    expect(zi.length).toBe(c.zi.length);
    zi.forEach((row, i) => expect(row).toBeAllClose(c.zi[i], { rtol: 1e-10, atol: 1e-12 }));
  });

  it("the steady state really is steady: constant in, constant out, from sample 0", () => {
    const { b, a } = butter(3, [4, 30], { btype: "bandstop", fs: 256 });
    const zi = lfilterZi(b, a).map((v) => v * 7);
    const y = lfilter(b, a, new Float32Array(50).fill(7), zi);
    const dc = (b.reduce((s, v) => s + v, 0) / a.reduce((s, v) => s + v, 0)) * 7;
    y.forEach((v) => expect(v).toBeCloseTo(dc, 5));
  });
});

describe("golden: lfilter / sosfilt with initial state", () => {
  it("lfilter(zi) matches scipy output and final state", () => {
    const c = extras.lfilterWithZi;
    const x = Float32Array.from(inputs[c.signal].channels[0].slice(0, extras.samples));
    const zi = [...c.zi];
    const y = lfilter(c.b, c.a, x, zi);
    expect(maxAbsDiff(y, c.output)).toBeLessThan(1e-6 * rmsOf(c.output));
    expect(zi).toBeAllClose(c.zf, { rtol: 1e-9, atol: 1e-7 * rmsOf(c.zf) });
  });

  it("sosfilt(zi) matches scipy output and final state", () => {
    const c = extras.sosfiltWithZi;
    const x = Float32Array.from(inputs[c.signal].channels[0].slice(0, extras.samples));
    const zi = c.zi.map((row) => [...row]);
    const y = sosfilt(fromSosMatrix(c.sos), x, zi);
    expect(maxAbsDiff(y, c.output)).toBeLessThan(1e-6 * rmsOf(c.output));
    zi.forEach((row, i) => expect(row).toBeAllClose(c.zf[i], { rtol: 1e-9, atol: 1e-7 }));
  });

  it("chunked calls that thread zi equal one call", () => {
    const sos = butter(4, [1, 40], { btype: "bandpass", fs: 256, output: "sos" });
    const x = Float32Array.from(inputs.eeg_muse_4s.channels[0]);
    const whole = sosfilt(sos, x);
    const zi = sos.map(() => [0, 0]);
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 12) parts.push(...sosfilt(sos, x.subarray(i, i + 12), zi));
    expect(maxAbsDiff(parts, whole)).toBe(0);
  });

  it("rejects a state of the wrong size", () => {
    expect(() => lfilter([1, 0.5], [1, -0.2], [1, 2, 3], [0, 0])).toThrow(RangeError);
  });
});

describe("golden: zero-phase filtering over pad types vs scipy", () => {
  // Every pad type and length, for ba, sos and FIR designs, including the
  // edges. Pass-through of `padlen: 0` and `padtype: null` is part of it.
  it.each(extras.padCases)("$id", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0].slice(0, extras.samples));
    const options = {
      padtype: c.padtype ?? ("none" as const),
      ...(c.padlen !== null ? { padlen: c.padlen } : {}),
    };
    const y = c.form === "sos" ? sosfiltfilt(c.sections!, x, options) : filtfilt(c.b!, c.a!, x, options);
    expect(maxAbsDiff(y, c.scipy)).toBeLessThan(2e-6 * rmsOf(c.scipy));
  });

  it("keeps the positional padtype form", () => {
    const x = Float32Array.from(inputs.ppg_muse_60bpm.channels[0]);
    const { b, a } = butter(2, 3, { fs: 64 });
    expect(filtfilt(b, a, x, "even")).toEqual(filtfilt(b, a, x, { padtype: "even" }));
  });

  it("an explicit padlen as long as the signal is rejected, as in SciPy", () => {
    const { b, a } = butter(2, 3, { fs: 64 });
    expect(() => filtfilt(b, a, new Float32Array(20), { padlen: 20 })).toThrow(RangeError);
  });

  it("a signal shorter than the default padlen still filters", () => {
    const { b, a } = butter(2, 3, { fs: 64 });
    const y = filtfilt(b, a, Float32Array.from({ length: 8 }, (_, i) => i));
    expect(y.length).toBe(8);
    y.forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });
});

describe("golden: Filtering node with method 'fir'", () => {
  const cases = firFx.cases.filter((c) =>
    ["lowpass_hamming:blackman", "highpass_hamming:hann", "bandpass_hamming:kaiser_8.6"].includes(c.id)
  );

  it.each(cases)("$id: node designs scipy's taps and streams them across packets", (c) => {
    const kind = (["lowpass", "highpass", "bandpass"] as const)[
      Array.isArray(c.cutoff) ? 2 : c.options.passZero === false ? 1 : 0
    ];
    const node = new Filtering({
      method: "fir",
      kind,
      cutoff: c.cutoff as number | [number, number],
      numtaps: c.numtaps,
      window: c.options.window as WindowSpec,
    });

    const name = "eeg_muse_4s";
    const count = inputs[name].channels.length;
    const out: number[][] = Array.from({ length: count }, () => []);
    for (const packet of packetStream(name, 12)) {
      channelsOf(node.analyze(packet)!.data, count).forEach((ch, i) => out[i].push(...ch));
    }

    // lfilter itself is checked against scipy above; here the reference is
    // that same engine run once, with SciPy's own taps from the fixture.
    out.forEach((ch, i) => {
      const expected = lfilter(c.taps, [1], Float32Array.from(inputs[name].channels[i]));
      expect(maxAbsDiff(ch, expected)).toBeLessThan(1e-6 * rmsOf(expected));
    });
  });

  it("zeroPhase uses filtfilt and removes the (numtaps - 1) / 2 sample delay", () => {
    const fs = 64;
    const x = Float32Array.from({ length: 640 }, (_, n) => Math.sin((2 * Math.PI * 1 * n) / fs));
    const base = packetStream("ppg_muse_60bpm", 640)[0];
    const packet = {
      ...base,
      data: x,
      metadata: { ...base.metadata, samplingRate: fs, channelCount: 1 },
    };
    const run = (zeroPhase: boolean) =>
      new Filtering({ method: "fir", kind: "lowpass", cutoff: 10, numtaps: 33, zeroPhase }).analyze(
        packet
      )!.data;

    // A 1 Hz tone is well inside the passband, so the only difference between
    // the two is the 16-sample delay (0.25 s = a quarter period, error ~0.7).
    expect(maxAbsDiff(run(true), x, 100, 540)).toBeLessThan(0.01);
    expect(maxAbsDiff(run(false), x, 100, 540)).toBeGreaterThan(0.5);
  });
});
