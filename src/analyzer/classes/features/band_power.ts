import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer, EmitOptions } from "../../base_analyzer";
import {
  getChannelCount,
  getStreamChannelCount,
  deinterleave,
} from "../../../utility";
import { spectrum, bandAverage, bandSum, SpectrumScaling } from "../../methods/fft";
import { WindowType } from "../../methods/window";

/** Frequency band definitions, in Hz, as `[low, high]`. */
export type BandDefinitions = Record<string, [number, number]>;

/**
 * EEG Band Power range definitions with beta as a more granular metric
 */
export const DEFAULT_EEG_BANDS: BandDefinitions = {
  Delta: [1, 4],
  Theta: [4, 8],
  Alpha: [8, 12],
  "Low beta": [12, 16],
  "High beta": [16, 25],
  Gamma: [25, 45],
};

export interface BandPowerParameters {
  /** Bands to compute. Defaults to {@link DEFAULT_EEG_BANDS}. */
  bands?: BandDefinitions;
  /** Emit one value per band per channel instead of averaging across channels. */
  perChannel?: boolean;
  /** Weight of each channel in the cross-channel average. */
  channelWeights?: number[];
  /**
   * How a band's bins are reduced. `"sum"` (default) integrates them: with
   * `"psd"` scaling that is absolute band power in units² (µV² for EEG).
   * `"mean"` averages them instead — mean spectral density in units²/Hz.
   */
  aggregate?: "mean" | "sum";
  /**
   * Emit each band as a fraction of the total across all bands, instead of
   * absolute power: relative band power. Normalised per channel when
   * `perChannel` is set, otherwise on the channel average.
   *
   * It is a share of *power* only with the default `scaling: "psd"` and
   * `aggregate: "sum"`. The total is the sum of the configured bands, so keep
   * them contiguous and non-overlapping.
   */
  relative?: boolean;
  window?: WindowType;
  scaling?: SpectrumScaling;
}

/**
 * Spectral band power.
 *
 * Expects a windowed input — chain it after {@link Windowing}, optionally with
 * {@link Filtering} in between. Output channels are the bands themselves, so
 * the channel labels a consumer sees are "Alpha", "Theta" and so on, ready to
 * bind straight to a visual parameter.
 *
 * Defaults give absolute band power, as YASA, MNE and EEGLAB report it: a
 * Hamming window, a power spectral density, integrated across each band
 * (units², µV² for EEG) then averaged across electrodes. Set
 * `relative: true` for each band's share of the total, or normalise
 * downstream. `scaling: "magnitude", aggregate: "mean"` is the original
 * You-Quantified measure, mean sinusoid amplitude across the band. Its
 * absolute values now read higher than the original code's by the window's
 * `nfft / sum(w)` (about 1.85 for an unpadded Hamming window), because that
 * code under-read amplitudes; `relative` output is unchanged.
 */
export class BandPower extends BaseAnalyzer {
  readonly name = "BandPower";
  readonly method = AnalysisMethod.BAND_POWER;
  readonly stage = ProcessingStage.FEATURES;

  constructor(parameters: BandPowerParameters = {}) {
    super({
      bands: DEFAULT_EEG_BANDS,
      perChannel: false,
      channelWeights: undefined,
      aggregate: "sum",
      relative: false,
      window: "hamming",
      scaling: "psd",
      ...parameters,
    });
  }

  readonly accepts: Accepts = { requiresSamplingRate: true };

  /**
   * Output channels are the bands, or band × electrode with `perChannel`,
   * band-major to match the order `analyze()` fills `values` in.
   */
  protected outputOptions(meta: StreamMetadata): EmitOptions {
    const bandNames = Object.keys(this.parameters.bands as BandDefinitions);
    const info = meta.channelInfo;

    let channelInfo: ChannelInfo[];
    if (this.parameters.perChannel) {
      const channels = getStreamChannelCount(meta);
      channelInfo = [];
      for (const band of bandNames) {
        for (let c = 0; c < channels; c++) {
          channelInfo.push({
            index: channelInfo.length,
            label: `${band} ${info?.[c]?.label ?? c + 1}`,
          });
        }
      }
    } else {
      channelInfo = bandNames.map((label, index) => ({ index, label }));
    }

    return {
      modality: meta.modality ?? Modality.EEG,
      name: "band_power",
      channelInfo,
      samplingRate: this.cadenceOf(meta),
      // One value per channel per packet: a feature, not a waveform.
      samplesPerChannel: 1,
      additionalMetadata: {
        bands: this.parameters.bands,
        relative: this.parameters.relative,
      },
    };
  }

  analyze(packet: DataPacket): DataPacket | null {
    const rate = packet.metadata.samplingRate;
    if (!rate) return null;

    const channels = getChannelCount(packet);
    const perChannelSignals = deinterleave(packet.data, channels);
    if (perChannelSignals.length === 0 || perChannelSignals[0].length < 2) {
      return null;
    }

    const bands = this.parameters.bands as BandDefinitions;
    const bandNames = Object.keys(bands);
    const aggregate = this.parameters.aggregate === "sum" ? bandSum : bandAverage;

    // bandsByChannel[channel][band]
    const bandsByChannel = perChannelSignals.map((signal) => {
      const spec = spectrum(signal, {
        samplingRate: rate,
        window: this.parameters.window,
        scaling: this.parameters.scaling,
        detrend: true,
      });
      return bandNames.map((band) =>
        aggregate(spec, bands[band][0], bands[band][1])
      );
    });

    let values: Float32Array;

    const relative = Boolean(this.parameters.relative);
    // Fraction of the channel's own total, so each channel's bands sum to 1.
    const channelTotals = bandsByChannel.map((bandValues) =>
      relative ? bandValues.reduce((a, b) => a + b, 0) || 1 : 1
    );

    if (this.parameters.perChannel) {
      values = new Float32Array(bandNames.length * channels);
      let index = 0;
      for (let b = 0; b < bandNames.length; b++) {
        for (let c = 0; c < channels; c++) {
          values[index++] = bandsByChannel[c][b] / channelTotals[c];
        }
      }
    } else {
      const weights: number[] =
        this.parameters.channelWeights ?? new Array(channels).fill(1);
      const totalWeight =
        weights.slice(0, channels).reduce((a, b) => a + b, 0) || 1;

      values = new Float32Array(bandNames.length);
      for (let b = 0; b < bandNames.length; b++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          sum += bandsByChannel[c][b] * (weights[c] ?? 1);
        }
        values[b] = sum / totalWeight;
      }
    }

    if (relative && !this.parameters.perChannel) {
      let total = 0;
      for (let i = 0; i < values.length; i++) total += values[i];
      if (total > 0) {
        for (let i = 0; i < values.length; i++) values[i] /= total;
      }
    }

    return this.emitDeclared(packet, values);
  }
}
