import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { MultiInputAnalyzer } from "../../base_analyzer";
import { getChannelCount, deinterleave, interleave } from "../../../utility";

export interface DifferenceParameters {
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
    this.syncPolicy = "latest";
  }

  compatible(metas: Record<string, StreamMetadata>): boolean {
    return Boolean(metas.a && metas.b);
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

    const labels = a.metadata.channelInfo;
    const prefix =
      this.parameters.mode === "similarity" ? "Similarity in" : "Difference in";

    const combined: Float32Array[] = [];
    const channelInfo: ChannelInfo[] = [];

    for (let c = 0; c < pairs; c++) {
      const samples = Math.min(channelsA[c].length, channelsB[c].length);
      const channel = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        channel[i] = this.combine(channelsA[c][i], channelsB[c][i]);
      }
      combined.push(channel);
      channelInfo.push({
        index: c,
        label: `${prefix} ${labels?.[c]?.label ?? `channel ${c + 1}`}`,
      });
    }

    if (this.parameters.summaryOnly) {
      const samples = combined[0].length;
      const summary = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (const channel of combined) sum += channel[i];
        summary[i] = sum / combined.length;
      }
      return this.emit(a, summary, {
        name: "difference",
        channelInfo: [{ index: 0, label: `Mean ${prefix.toLowerCase()} all` }],
        samplingRate: a.metadata.samplingRate,
      });
    }

    return this.emit(a, interleave(combined), {
      name: "difference",
      channelInfo,
      samplingRate: a.metadata.samplingRate,
    });
  }
}
