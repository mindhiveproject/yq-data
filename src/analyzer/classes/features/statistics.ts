import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, deinterleave } from "../../../utility";
import {
  mean,
  standardDeviation,
  rms,
  minimum,
  maximum,
  dbfs,
} from "../../methods/stats";

export type StatisticName =
  | "mean"
  | "std"
  | "rms"
  | "min"
  | "max"
  | "range"
  | "peakToPeak";

export interface StatisticalParameters {
  /** Statistics to compute, in output order. */
  features?: StatisticName[];
}

const COMPUTE: Record<StatisticName, (x: Float32Array) => number> = {
  mean,
  std: (x) => standardDeviation(x),
  rms,
  min: minimum,
  max: maximum,
  range: (x) => maximum(x) - minimum(x),
  peakToPeak: (x) => maximum(x) - minimum(x),
};

/**
 * Summary statistics over a windowed signal, per channel.
 *
 * Output channels are the cross product of input channels and requested
 * features, labelled "AF7 rms" and so on.
 */
export class StatisticalFeatures extends BaseAnalyzer {
  readonly name = "StatisticalFeatures";
  readonly method = AnalysisMethod.STATISTICAL_FEATURES;
  readonly stage = ProcessingStage.FEATURES;

  constructor(parameters: StatisticalParameters = {}) {
    super({ features: ["mean", "std", "rms"], ...parameters });
  }

  readonly accepts: Accepts = {};

  analyze(packet: DataPacket): DataPacket | null {
    const channels = getChannelCount(packet);
    const perChannel = deinterleave(packet.data, channels);
    if (perChannel.length === 0 || perChannel[0].length === 0) return null;

    const features = this.parameters.features as StatisticName[];
    const info = packet.metadata.channelInfo;

    const values = new Float32Array(channels * features.length);
    const channelInfo: ChannelInfo[] = [];

    let index = 0;
    for (let c = 0; c < channels; c++) {
      for (const feature of features) {
        values[index] = COMPUTE[feature](perChannel[c]);
        channelInfo.push({
          index,
          label: `${info?.[c]?.label ?? `Channel ${c + 1}`} ${feature}`,
        });
        index++;
      }
    }

    return this.emit(packet, values, {
      name: "statistics",
      channelInfo,
      samplingRate: packet.metadata.additionalMetadata?.packetRate,
    });
  }
}

export interface RMSParameters {
  /** Report as decibels relative to full scale rather than linear amplitude. */
  decibels?: boolean;
  /** Floor for the dBFS conversion, so silence does not report -Infinity. */
  floor?: number;
}

/**
 * Root mean square amplitude per channel — microphone loudness, EMG envelope,
 * or overall EEG signal strength.
 *
 * In `decibels` mode the output is dBFS: negative values approaching 0 at full
 * scale, which is the convention the original audio-volume device used.
 *
 * That device computed loudness with essentia.js; this is a plain RMS over the
 * raw PCM the microphone worklet already delivers, which needs no WASM build
 * and keeps audio on the same analyzer path as every other modality.
 */
export class RMSAnalyzer extends BaseAnalyzer {
  readonly name = "RMS";
  readonly method = AnalysisMethod.RMS;
  readonly stage = ProcessingStage.FEATURES;

  constructor(parameters: RMSParameters = {}) {
    super({ decibels: false, floor: -100, ...parameters });
  }

  readonly accepts: Accepts = {};

  analyze(packet: DataPacket): DataPacket | null {
    const channels = getChannelCount(packet);
    const perChannel = deinterleave(packet.data, channels);
    if (perChannel.length === 0 || perChannel[0].length === 0) return null;

    const info = packet.metadata.channelInfo;
    const values = new Float32Array(channels);
    const channelInfo: ChannelInfo[] = [];

    for (let c = 0; c < channels; c++) {
      const value = rms(perChannel[c]);
      values[c] = this.parameters.decibels
        ? dbfs(value, this.parameters.floor)
        : value;
      channelInfo.push({
        index: c,
        label: `${info?.[c]?.label ?? `Channel ${c + 1}`} volume`,
        unit: this.parameters.decibels ? "dBFS" : undefined,
      });
    }

    return this.emit(packet, values, {
      name: "rms",
      channelInfo,
      samplingRate: packet.metadata.additionalMetadata?.packetRate,
    });
  }
}
