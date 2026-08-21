import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, deinterleave, interleave } from "../../../utility";
import { minMaxNormalize, zScore, remap } from "../../methods/stats";

export type NormalizationMode =
  /** Rescale each packet to [0, 1] using that packet's own extremes. */
  | "minmax"
  /** Zero mean, unit variance, per packet. */
  | "zscore"
  /** Rescale against a running estimate of the signal's range. */
  | "running"
  /** Rescale against author-supplied `min` and `max`. */
  | "fixed";

export interface NormalizationParameters {
  mode?: NormalizationMode;
  /** Output range. Defaults to [0, 1]. */
  outMin?: number;
  outMax?: number;
  /** Input range, for `fixed` mode. */
  min?: number;
  max?: number;
  /**
   * Decay applied to the running range each packet, for `running` mode.
   *
   * Slightly below 1 so the observed range contracts over time; without it, a
   * single artifact would permanently widen the range and flatten everything
   * after it.
   */
  decay?: number;
}

/**
 * Rescales a signal into a bounded range.
 *
 * `running` is the mode that matters for driving a visual: biosignal
 * amplitudes vary by an order of magnitude between people and between
 * sessions, so a fixed range either clips or barely moves, while per-packet
 * min-max normalization destroys the very variation being visualized. A
 * decaying running range adapts to the wearer without erasing dynamics.
 */
export class Normalization extends BaseAnalyzer {
  readonly name = "Normalization";
  readonly method = AnalysisMethod.NORMALIZATION;
  readonly stage = ProcessingStage.PREPROCESSED;

  private runningMin: number[] = [];
  private runningMax: number[] = [];

  constructor(parameters: NormalizationParameters = {}) {
    super({
      mode: "running",
      outMin: 0,
      outMax: 1,
      min: 0,
      max: 1,
      decay: 0.999,
      ...parameters,
    });
  }

  readonly accepts: Accepts = {};

  public reset(): void {
    this.runningMin = [];
    this.runningMax = [];
  }

  analyze(packet: DataPacket): DataPacket | null {
    const channels = getChannelCount(packet);
    const perChannel = deinterleave(packet.data, channels);
    const { mode, outMin, outMax } = this.parameters;

    const normalized = perChannel.map((signal, channel) => {
      switch (mode) {
        case "minmax": {
          const unit = minMaxNormalize(signal);
          return this.scale(unit, outMin, outMax);
        }
        case "zscore":
          return zScore(signal);
        case "fixed": {
          const out = new Float32Array(signal.length);
          for (let i = 0; i < signal.length; i++) {
            out[i] = remap(
              signal[i],
              this.parameters.min,
              this.parameters.max,
              outMin,
              outMax
            );
          }
          return out;
        }
        case "running":
        default:
          return this.runningNormalize(signal, channel, outMin, outMax);
      }
    });

    return this.emit(packet, interleave(normalized), {
      name: `normalized`,
      samplingRate: packet.metadata.samplingRate,
    });
  }

  private scale(unit: Float32Array, outMin: number, outMax: number) {
    if (outMin === 0 && outMax === 1) return unit;
    const out = new Float32Array(unit.length);
    for (let i = 0; i < unit.length; i++) {
      out[i] = outMin + unit[i] * (outMax - outMin);
    }
    return out;
  }

  private runningNormalize(
    signal: Float32Array,
    channel: number,
    outMin: number,
    outMax: number
  ): Float32Array {
    const out = new Float32Array(signal.length);
    const decay = this.parameters.decay;

    let lo = this.runningMin[channel];
    let hi = this.runningMax[channel];

    for (let i = 0; i < signal.length; i++) {
      const value = signal[i];

      if (lo === undefined || hi === undefined) {
        lo = value;
        hi = value;
      } else {
        // Contract toward the midpoint, then expand to admit the new sample.
        const mid = (lo + hi) / 2;
        lo = mid + (lo - mid) * decay;
        hi = mid + (hi - mid) * decay;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }

      out[i] = remap(value, lo, hi, outMin, outMax);
    }

    this.runningMin[channel] = lo!;
    this.runningMax[channel] = hi!;

    return out;
  }
}
