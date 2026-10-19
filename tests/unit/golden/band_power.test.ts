/**
 * Golden-value tests: BandPower.
 *
 * Fixture: `band_power.json` (see `ref_spectral.py`). Two questions:
 *
 *  1. Conformance -- does BandPower compute what it documents? Reference: the
 *     package's convention (periodogram + [floor(lo/res), floor(hi/res)) bin
 *     selection) evaluated with SciPy. Expected to match to float32 precision.
 *  2. Field standard -- does the number mean what an EEG researcher would take
 *     it to mean? Reference: YASA `bandpower` (Vallat & Walker, 2021), i.e.
 *     Welch PSD integrated over each band. Judged with a stated tolerance.
 *
 * `[divergence]` tests use `divergence` (= `it.failing`); see README.md.
 */
import "./allclose";
import { BandPower, BandPowerParameters } from "../../../src";
import { divergence, fixture, inputs, packetFor, recorder } from "./harness";

interface OwnConvention extends Required<
  Pick<BandPowerParameters, "window" | "scaling" | "aggregate" | "relative">
> {
  channelAverage: number[];
  perChannel: number[][];
}

interface BandPowerDoc {
  cases: {
    signal: string;
    bands: Record<string, [number, number]>;
    ownConvention: OwnConvention[];
    integratedPsdPerChannel: number[][];
    yasa: {
      absolutePerChannel: number[][];
      relativePerChannel: number[][];
      relativeChannelAverage: number[];
    };
  }[];
}

const golden = fixture<BandPowerDoc>("band_power");
const rec = recorder("band_power");
afterAll(() => rec.flush());

/** The BandPower parameters a fixture configuration describes. */
const params = ({ window, scaling, aggregate, relative }: OwnConvention) => ({
  window,
  scaling,
  aggregate,
  relative,
});

const mean = (rows: number[][]) =>
  rows[0].map((_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);

/** BandPower perChannel output is band-major: index = band * channels + channel. */
const perChannelRows = (data: ArrayLike<number>, channels: number, bands: number) =>
  Array.from({ length: channels }, (_, c) =>
    Array.from({ length: bands }, (_, b) => data[b * channels + c])
  );

// Agreement bar against YASA's relative band power, in absolute fraction of
// total power. Short windows (2-4 s) leave only 6-16 bins per band, where
// YASA's inclusive edges and Simpson weighting legitimately move a band by a
// few percent; 0.04 is the measured spread between two correct pipelines.
const YASA_RELATIVE_ATOL = 0.04;

describe.each(golden.cases)("golden: BandPower on $signal", (c) => {
  const packet = packetFor(c.signal);
  const channels = inputs[c.signal].channels.length;
  const bandCount = Object.keys(c.bands).length;
  const run = (p: BandPowerParameters) => new BandPower(p).analyze(packet)!;

  describe("conformance with its own documented convention", () => {
    it.each(c.ownConvention)(
      "$window / $scaling / $aggregate / relative=$relative, channel average",
      (cfg) => {
        const out = run(params(cfg));
        rec.record(`own:${c.signal}:${cfg.window}:${cfg.scaling}:${cfg.aggregate}:${cfg.relative}`, out.data);
        expect(Array.from(out.data)).toBeAllClose(cfg.channelAverage, { rtol: 1e-5 });
      }
    );

    it.each(c.ownConvention.filter((cfg) => !cfg.relative))(
      "$window / $scaling / $aggregate, perChannel",
      (cfg) => {
        const out = run({ ...params(cfg), perChannel: true });
        const rows = perChannelRows(out.data, channels, bandCount);
        expect(rows.flat()).toBeAllClose(cfg.perChannel.flat(), { rtol: 1e-5 });
      }
    );
  });

  describe("against the field standard (YASA bandpower)", () => {
    const yasaRelative = c.yasa.relativeChannelAverage;

    it(`psd + sum + relative agrees with YASA within ${YASA_RELATIVE_ATOL}`, () => {
      for (const window of ["hann", "hamming"] as const) {
        const out = run({ window, scaling: "psd", aggregate: "sum", relative: true });
        rec.record(`yasaCompare:${c.signal}:${window}`, out.data);
        expect(Array.from(out.data)).toBeAllClose(yasaRelative, {
          rtol: 0,
          atol: YASA_RELATIVE_ATOL,
        });
      }
    });

    // The default configuration (magnitude scaling, mean over bins) averages
    // *amplitudes*, so `relative: true` yields a share of summed mean
    // amplitude, not a share of power. Divergence D2.
    divergence(
      "[divergence] default config with relative: true is a fraction of power",
      () => {
        const out = run({ relative: true });
        rec.record(`yasaCompare:${c.signal}:default`, out.data);
        expect(Array.from(out.data)).toBeAllClose(yasaRelative, {
          rtol: 0,
          atol: YASA_RELATIVE_ATOL,
        });
      }
    );

    // bandSum is documented as "for total band power", but sums PSD bins
    // (units^2/Hz) without multiplying by the bin width, so the result is
    // band power divided by the frequency resolution. Divergence D4.
    divergence(
      "[divergence] psd + sum is band power in units^2 (integral of the PSD)",
      () => {
        const out = run({ window: "hamming", scaling: "psd", aggregate: "sum" });
        expect(Array.from(out.data)).toBeAllClose(mean(c.integratedPsdPerChannel), {
          rtol: 1e-4,
        });
      }
    );

    // perChannel + relative divides every value by the sum over *all* bands
    // of *all* channels, so one channel's bands do not sum to 1 -- unlike
    // YASA's per-channel relative power. Divergence D5.
    if (channels > 1) {
      divergence(
        "[divergence] perChannel + relative gives each channel's own band fractions",
        () => {
          const out = run({ scaling: "psd", aggregate: "sum", relative: true, perChannel: true });
          const rows = perChannelRows(out.data, channels, bandCount);
          rec.record(`perChannelRelative:${c.signal}`, rows);
          for (const row of rows) {
            expect([row.reduce((s, v) => s + v, 0)]).toBeAllClose([1], { rtol: 1e-5 });
          }
        }
      );
    }
  });
});
