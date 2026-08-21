import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer } from "../../base_analyzer";

export interface WindowingParameters {
  /** Window length. Seconds unless `unit` says otherwise. */
  size?: number;
  /** Step between consecutive windows. Defaults to `size` (no overlap). */
  hop?: number;
  /** Whether `size` and `hop` are expressed in seconds or in samples. */
  unit?: "seconds" | "samples";
  /**
   * Emit partial windows padded with zeros before the buffer has filled.
   *
   * Off by default: a half-empty window has a distorted spectrum, and a visual
   * bound to it would show a misleading value for the first few seconds.
   */
  emitPartial?: boolean;
}

/**
 * Accumulates streaming packets into fixed-length, optionally overlapping
 * windows.
 *
 * Devices deliver signal in whatever chunk size their transport dictates —
 * Muse sends 12 EEG samples at a time — while spectral analysis needs a window
 * of a second or more. Making that buffering an explicit node rather than
 * hiding it inside each analyzer keeps every downstream analyzer stateless and
 * makes the window length a visible property of the graph.
 *
 * Returns `null` for every packet that only partially fills the buffer.
 */
export class Windowing extends BaseAnalyzer {
  readonly name = "Windowing";
  readonly method = AnalysisMethod.WINDOWING;
  readonly stage = ProcessingStage.PREPROCESSED;

  /** Interleaved sample buffer, drained a hop at a time. */
  private buffer: number[] = [];
  private channelCount = 1;

  constructor(parameters: WindowingParameters = {}) {
    super({
      size: 2,
      hop: undefined,
      unit: "seconds",
      emitPartial: false,
      ...parameters,
    });
  }

  /** A size in seconds needs a rate to interpret it; in samples it does not. */
  get accepts(): Accepts {
    return { requiresSamplingRate: this.parameters.unit !== "samples" };
  }

  public reset(): void {
    this.buffer = [];
  }

  /** Window length in samples per channel, for a given stream. */
  private windowSamples(meta: StreamMetadata): number {
    if (this.parameters.unit === "samples") {
      return Math.max(1, Math.floor(this.parameters.size));
    }
    const rate = meta.samplingRate ?? 0;
    return Math.max(1, Math.round(this.parameters.size * rate));
  }

  private hopSamples(meta: StreamMetadata): number {
    const size = this.windowSamples(meta);
    const hop = this.parameters.hop;
    if (hop === undefined || hop === null) return size;
    if (this.parameters.unit === "samples") {
      return Math.max(1, Math.min(size, Math.floor(hop)));
    }
    const rate = meta.samplingRate ?? 0;
    return Math.max(1, Math.min(size, Math.round(hop * rate)));
  }

  analyze(packet: DataPacket): DataPacket | null {
    const meta = packet.metadata;
    const channels = meta.channelCount ?? meta.channelInfo?.length ?? 1;

    // A changed channel layout invalidates everything buffered under the old one.
    if (channels !== this.channelCount) {
      this.channelCount = channels;
      this.buffer = [];
    }

    for (let i = 0; i < packet.data.length; i++) this.buffer.push(packet.data[i]);

    const windowSamples = this.windowSamples(meta);
    const hopSamples = this.hopSamples(meta);
    const needed = windowSamples * channels;

    if (this.buffer.length < needed) {
      if (!this.parameters.emitPartial) return null;
      const padded = new Float32Array(needed);
      padded.set(this.buffer);
      return this.buildPacket(packet, padded, windowSamples, hopSamples);
    }

    const window = Float32Array.from(this.buffer.slice(0, needed));
    this.buffer.splice(0, hopSamples * channels);

    return this.buildPacket(packet, window, windowSamples, hopSamples);
  }

  private buildPacket(
    input: DataPacket,
    data: Float32Array,
    windowSamples: number,
    hopSamples: number
  ): DataPacket {
    const rate = input.metadata.samplingRate;

    return this.emit(input, data, {
      name: "windowed",
      additionalMetadata: {
        windowSamples,
        hopSamples,
        windowSeconds: rate ? windowSamples / rate : undefined,
        // How often a downstream node will see a packet. Feature analyzers
        // publish this as their own sampling rate.
        packetRate: rate ? rate / hopSamples : undefined,
      },
    });
  }
}
