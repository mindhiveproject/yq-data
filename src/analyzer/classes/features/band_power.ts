import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  Modality,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, deinterleave } from "../../../utility";
import { spectrum, bandAverage, bandSum, SpectrumScaling } from "../../methods/fft";
import { WindowType } from "../../methods/window";

/** Frequency band definitions, in Hz, as `[low, high)`. */
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
  /** Sum bin values across the band instead of averaging them. */
  aggregate?: "mean" | "sum";
  /** Also emit each band as a fraction of total power across all bands. */
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
 * Defaults reproduce the original You-Quantified numbers: a Hamming window,
 * magnitude scaling, and a mean across bins then across electrodes.
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
      aggregate: "mean",
      relative: false,
      window: "hamming",
      scaling: "magnitude",
      ...parameters,
    });
  }

  readonly accepts: Accepts = { requiresSamplingRate: true };

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

    const info = packet.metadata.channelInfo;
    let values: Float32Array;
    let channelInfo: ChannelInfo[];

    if (this.parameters.perChannel) {
      values = new Float32Array(bandNames.length * channels);
      channelInfo = [];
      let index = 0;
      for (let b = 0; b < bandNames.length; b++) {
        for (let c = 0; c < channels; c++) {
          values[index] = bandsByChannel[c][b];
          channelInfo.push({
            index,
            label: `${bandNames[b]} ${info?.[c]?.label ?? c + 1}`,
          });
          index++;
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
      channelInfo = bandNames.map((label, index) => ({ index, label }));
    }

    if (this.parameters.relative) {
      let total = 0;
      for (let i = 0; i < values.length; i++) total += values[i];
      if (total > 0) {
        for (let i = 0; i < values.length; i++) values[i] /= total;
      }
    }

    return this.emit(packet, values, {
      modality: packet.metadata.modality ?? Modality.EEG,
      name: "band_power",
      channelInfo,
      samplingRate: packet.metadata.additionalMetadata?.packetRate,
      additionalMetadata: { bands, relative: this.parameters.relative },
    });
  }
}
