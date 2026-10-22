import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import {
  Accepts,
  EmitOptions,
  MultiInputAnalyzer,
  SyncParameters,
} from "../../base_analyzer";
import {
  getChannelCount,
  getStreamChannelCount,
  deinterleave,
  interleave,
} from "../../../utility";

export interface DifferenceParameters extends SyncParameters {
  /**
   * `similarity` returns `1 - |a - b|`, which is the face-synchrony measure:
   * two people pulling the same expression score near 1, opposite expressions
   * near 0. It assumes both inputs are already on a 0–1 scale, as MediaPipe
   * blendshape scores are.
   */
  mode?: "signed" | "absolute" | "similarity";
  /** Also emit the mean across channels as a single summary value. */
  summaryOnly?: boolean;
}

/**
 * Element-wise comparison of two aligned streams.
 *
 * The intended use is facial synchrony between two people's blendshape
 * streams, where the channels are the same 52 expressions on both sides, but
 * it works for any two streams sharing a channel layout.
 */
export class Difference extends MultiInputAnalyzer {
  readonly name = "Difference";
  readonly method = AnalysisMethod.CUSTOM;
  readonly stage = ProcessingStage.FEATURES;
  readonly ports = ["a", "b"];

  constructor(parameters: DifferenceParameters = {}) {
    super({ mode: "similarity", summaryOnly: false, ...parameters });
  }

  readonly accepts: Record<string, Accepts> = { a: {}, b: {} };

  /**
   * Channels are named after port `a`'s, one per pair, or a single mean. The
   * packet keeps its length, so it is a waveform exactly when both inputs are.
   */
  protected outputOptions(inputs: Record<string, StreamMetadata>): EmitOptions {
    const a = inputs.a;
    const b = inputs.b;
    const labels = a.channelInfo;
    const prefix =
      this.parameters.mode === "similarity" ? "Similarity in" : "Difference in";
    const pairs = Math.min(getStreamChannelCount(a), getStreamChannelCount(b));

    const samplesPerChannel =
      a.samplesPerChannel !== undefined && b.samplesPerChannel !== undefined
        ? Math.min(a.samplesPerChannel, b.samplesPerChannel)
        : undefined;

    const channelInfo: ChannelInfo[] = this.parameters.summaryOnly
      ? [{ index: 0, label: `Mean ${prefix.toLowerCase()} all` }]
      : Array.from({ length: pairs }, (_, c) => ({
          index: c,
          label: `${prefix} ${labels?.[c]?.label ?? `channel ${c + 1}`}`,
        }));

    return {
      name: "difference",
      channelInfo,
      samplingRate: a.samplingRate,
      samplesPerChannel,
    };
  }

  private combine(x: number, y: number): number {
    switch (this.parameters.mode) {
      case "signed":
        return x - y;
      case "absolute":
        return Math.abs(x - y);
      case "similarity":
      default:
        return 1 - Math.abs(x - y);
    }
  }

  analyze(packets: Record<string, DataPacket>): DataPacket | null {
    const a = packets.a;
    const b = packets.b;
    if (!a || !b) return null;

    const channelsA = deinterleave(a.data, getChannelCount(a));
    const channelsB = deinterleave(b.data, getChannelCount(b));
    const pairs = Math.min(channelsA.length, channelsB.length);
    if (pairs === 0) return null;

    const combined: Float32Array[] = [];

    for (let c = 0; c < pairs; c++) {
      const samples = Math.min(channelsA[c].length, channelsB[c].length);
      const channel = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        channel[i] = this.combine(channelsA[c][i], channelsB[c][i]);
      }
      combined.push(channel);
    }

    if (this.parameters.summaryOnly) {
      const samples = combined[0].length;
      const summary = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (const channel of combined) sum += channel[i];
        summary[i] = sum / combined.length;
      }
      return this.emitDeclared(packets, summary);
    }

    return this.emitDeclared(packets, interleave(combined));
  }
}
