import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer, EmitOptions } from "../../base_analyzer";
import { ParameterSchema } from "../../parameters";

export interface LimitParameters {
  /** Values below it become it. Left out, there is no lower bound. */
  min?: number;
  /** Values above it become it. Left out, there is no upper bound. */
  max?: number;
}

/**
 * Clamps every value between `min` and `max`: TouchDesigner's Limit CHOP.
 * Channels, rate, labels and units carry through.
 */
export class Limit extends BaseAnalyzer {
  readonly name = "Limit";
  readonly method = AnalysisMethod.LIMIT;
  readonly stage = ProcessingStage.PREPROCESSED;
  readonly accepts: Accepts = {};

  static readonly schema: ParameterSchema = {
    min: { type: "number", description: "Lower bound. Left out, none." },
    max: { type: "number", description: "Upper bound. Left out, none." },
  };

  constructor(parameters: LimitParameters = {}) {
    super(parameters);
    const { min, max } = this.parameters;
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`Limit min (${min}) is above its max (${max}).`);
    }
  }

  protected outputOptions(meta: StreamMetadata): EmitOptions {
    return {
      name: "limit",
      samplingRate: meta.samplingRate,
      samplesPerChannel: meta.samplesPerChannel,
    };
  }

  analyze(packet: DataPacket): DataPacket | null {
    const min = this.parameters.min ?? -Infinity;
    const max = this.parameters.max ?? Infinity;
    const out = new Float32Array(packet.data.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.min(max, Math.max(min, packet.data[i]));
    }
    return this.emitDeclared(packet, out);
  }
}
