/**
 * Golden-value tests: Butterworth design (by response), the
 * difference-equation engine, the streaming Filtering node and zero-phase
 * filtering, against SciPy.
 *
 * Fixtures: `filter_design.json`, `lfilter.json`, `filter_streaming.json`,
 * `filtfilt.json` (see `ref_filter.py`). Coefficient-level design, FIR
 * design, windows, initial conditions and pad types are in
 * `filter_design.test.ts`.
 *
 * Here the design is compared by magnitude response |H(f)|, the quantity a
 * user hears or sees. `order` is the `N` of `scipy.signal.butter(N, ...)`, so
 * band filters have 2N poles in both.
 */
import "./allclose";
import {
  Biquad,
  FilterKind,
  Filtering,
  designFilter,
  filtfilt,
  sosfiltfilt,
  lfilter,
} from "../../../src";
import {
  cascadeMagnitude,
  channelsOf,
  fixture,
  inputs,
  maxAbsDiff,
  packetStream,
  rmsOf,
  toDb,
} from "./harness";

interface DesignCase {
  id: string;
  kind: FilterKind;
  cutoff: number | [number, number];
  samplingRate: number;
  order: number;
  why: string;
  frequencies: number[];
  magnitude: number[];
}

const design = fixture<{ cases: DesignCase[] }>("filter_design");
const lf = fixture<{
  cases: { id: string; signal: string; b: number[]; a: number[]; output: number[] }[];
}>("lfilter");
const streaming = fixture<{
  cases: {
    id: string;
    signal: string;
    kind: FilterKind;
    cutoff: number | [number, number];
    order: number;
    packetSize: number;
    output: number[][];
  }[];
}>("filter_streaming");
const ff = fixture<{
  cases: {
    id: string;
    signal: string;
    b: number[];
    a: number[];
    scipy: number[];
  }[];
  sosCases: { id: string; signal: string; sections: Biquad[]; scipy: number[] }[];
}>("filtfilt");


const responseOf = (c: DesignCase) =>
  cascadeMagnitude(
    designFilter({
      kind: c.kind,
      cutoff: c.cutoff,
      samplingRate: c.samplingRate,
      order: c.order,
    }),
    c.frequencies,
    c.samplingRate
  );

describe("golden: Butterworth design vs scipy.signal.butter", () => {
  it.each(design.cases)("$id ($why)", (c) => {
    const actual = responseOf(c);
    // The design is SciPy's own algorithm, so the response agrees to rounding
    // error: measured 1e-15 for most cases, 1e-12 for the 0.5 Hz high-pass.
    expect(actual).toBeAllClose(c.magnitude, { rtol: 0, atol: 1e-10 });
  });

  it.each(design.cases)("$id: -3.01 dB at the cutoff frequencies", (c) => {
    const actual = responseOf(c);
    const edges = Array.isArray(c.cutoff) ? c.cutoff : [c.cutoff];
    const atEdges = edges.map((f) => toDb(actual[c.frequencies.indexOf(f)]));
    // A Butterworth filter of any order and type is -3.0103 dB (1/sqrt 2) at
    // each cutoff by definition. The old RBJ band design missed this by 3 dB
    // per section (D1, closed).
    expect(atEdges).toBeAllClose(edges.map(() => -3.0103), { rtol: 0, atol: 0.001 });
  });
});

describe("golden: lfilter vs scipy.signal.lfilter", () => {
  describe.each(lf.cases)("$id on $signal", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0]);
    const y = lfilter(c.b, c.a, x);

    it("matches to float32 precision of the output scale", () => {
      // The recursion runs in float64 and is rounded once, on output, so the
      // only difference from SciPy is that final float32 rounding (6e-8
      // relative). Poles near z = 1 -- the 0.5 Hz high-pass on a 5000 uV
      // offset -- no longer amplify it, as they did when y was fed back at
      // float32 width (3e-5 of output RMS before).
      const tol = 1e-6 * rmsOf(c.output);
      expect(maxAbsDiff(y, c.output)).toBeLessThan(tol);
    });
  });
});

describe("golden: Filtering node, streamed in device-sized packets", () => {
  const run = (c: (typeof streaming.cases)[number]) => {
    const node = new Filtering({ kind: c.kind, cutoff: c.cutoff, order: c.order });
    const count = inputs[c.signal].channels.length;
    const out: number[][] = Array.from({ length: count }, () => []);
    for (const packet of packetStream(c.signal, c.packetSize)) {
      channelsOf(node.analyze(packet)!.data, count).forEach((ch, i) => out[i].push(...ch));
    }
    return out;
  };

  it.each(streaming.cases)("$id: state carries across $packetSize-sample packets", (c) => {
    const out = run(c);
    out.forEach((ch, i) => {
      // Same float32 budget as lfilter above: chunking adds nothing, which is
      // the point -- 640 packet boundaries and no discontinuity at any.
      expect(maxAbsDiff(ch, c.output[i])).toBeLessThan(1e-6 * rmsOf(c.output[i]));
    });
  });
});

describe("golden: zero-phase filtering vs scipy.signal.filtfilt", () => {
  const EDGE = 64; // samples treated as "edge"; 1 s at 64 Hz

  describe.each(ff.cases)("$id", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0]);
    const y = filtfilt(c.b, c.a, x);
    const scale = rmsOf(c.scipy);
    it("interior matches scipy.signal.filtfilt", () => {
      expect(maxAbsDiff(y, c.scipy, EDGE, x.length - EDGE)).toBeLessThan(1e-6 * scale);
    });

    // Odd padding alone leaves the start-up transient in the result; SciPy
    // also seeds each pass with the step-response steady state (lfilter_zi;
    // cf. Gustafsson 1996), and so does filtfilt. Closed D6.
    it("edges match scipy.signal.filtfilt", () => {
      expect(maxAbsDiff(y, c.scipy)).toBeLessThan(1e-6 * scale);
    });
  });

  describe.each(ff.sosCases)("$id (cascade)", (c) => {
    const x = Float32Array.from(inputs[c.signal].channels[0]);
    const y = sosfiltfilt(c.sections, x);
    const scale = rmsOf(c.scipy);

    it("matches scipy.signal.sosfiltfilt, edges included", () => {
      // The whole cascade runs forward then backward, each section seeded at
      // its own steady state, as in sosfiltfilt.
      expect(maxAbsDiff(y, c.scipy)).toBeLessThan(1e-6 * scale);
    });
  });
});
