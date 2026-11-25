import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer, EmitOptions } from "../../base_analyzer";
import { getChannelCount } from "../../../utility";
import { ParameterSchema } from "../../parameters";

export interface LagParameters {
  /** Time constant, in seconds, while the value rises. Defaults to 0.2. */
  lagUp?: number;
  /** Time constant, in seconds, while the value falls. Defaults to 0.2. */
  lagDown?: number;
}

/**
 * Smooths each channel toward its incoming value: TouchDesigner's Lag CHOP.
 *
 * Exponential, with a time constant in seconds per direction, so a value can
 * rise quickly and settle slowly. After one time constant the output has
 * covered about 63% of a step. The step per sample comes from the stream's
 * sampling rate; a stream without one is timed by its packet timestamps.
 * Channels, rate, labels and units carry through.
 */
export class Lag extends BaseAnalyzer {
  readonly name = "Lag";
  readonly method = AnalysisMethod.LAG;
  readonly stage = ProcessingStage.PREPROCESSED;
  readonly accepts: Accepts = {};

  static readonly schema: ParameterSchema = {
    lagUp: { type: "number", min: 0, default: 0.2, unit: "s" },
    lagDown: { type: "number", min: 0, default: 0.2, unit: "s" },
  };

  private state: number[] = [];
  private lastTimestamp?: number;

  constructor(parameters: LagParameters = {}) {
    super(parameters);
  }

  public reset(): void {
    this.state = [];
    this.lastTimestamp = undefined;
  }

  protected outputOptions(meta: StreamMetadata): EmitOptions {
    return {
      name: "lag",
      samplingRate: meta.samplingRate,
      samplesPerChannel: meta.samplesPerChannel,
    };
  }

  analyze(packet: DataPacket): DataPacket | null {
    const channels = getChannelCount(packet);
    const samples = Math.floor(packet.data.length / channels);
    if (samples === 0) return null;

    const rate = packet.metadata.samplingRate;
    const elapsed =
      this.lastTimestamp === undefined ? 0 : (packet.timestamp - this.lastTimestamp) / 1000;
    const dt = rate ? 1 / rate : Math.max(0, elapsed) / samples;
    this.lastTimestamp = packet.timestamp;

    const step = (tau: number) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
    const up = step(this.parameters.lagUp);
    const down = step(this.parameters.lagDown);

    const out = new Float32Array(samples * channels);
    for (let i = 0; i < samples; i++) {
      for (let c = 0; c < channels; c++) {
        const x = packet.data[i * channels + c];
        const y = this.state[c];
        const next = y === undefined || !Number.isFinite(y) ? x : y + (x - y) * (x > y ? up : down);
        this.state[c] = next;
        out[i * channels + c] = next;
      }
    }

    return this.emitDeclared(packet, out);
  }
}
