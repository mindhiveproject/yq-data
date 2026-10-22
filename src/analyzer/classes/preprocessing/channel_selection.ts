import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer, EmitOptions } from "../../base_analyzer";
import {
  getChannelCount,
  getStreamChannelCount,
  deinterleave,
  interleave,
} from "../../../utility";

export interface ChannelSelectionParameters {
  /** Channel indices to keep, in output order. */
  indices?: number[];
  /** Channel labels to keep, in output order. Takes precedence over indices. */
  labels?: string[];
  /** Average the selected channels into one instead of keeping them separate. */
  average?: boolean;
}

/**
 * Narrows a multi-channel stream to a subset of its channels.
 *
 * Both the Muse PPG pipeline (only the infrared channel carries a usable
 * pulse) and any single-electrode mapping need this, and selecting early keeps
 * every downstream node from doing work on channels nobody reads.
 */
export class ChannelSelection extends BaseAnalyzer {
  readonly name = "ChannelSelection";
  readonly method = AnalysisMethod.CHANNEL_SELECTION;
  readonly stage = ProcessingStage.PREPROCESSED;

  constructor(parameters: ChannelSelectionParameters = {}) {
    super({ indices: [0], labels: undefined, average: false, ...parameters });
  }

  readonly accepts: Accepts = {};

  private resolveIndices(meta: StreamMetadata, channels: number): number[] {
    const labels: string[] | undefined = this.parameters.labels;

    if (labels && labels.length > 0) {
      const info = meta.channelInfo ?? [];
      return labels
        .map((label) => info.find((c) => c.label === label)?.index)
        .filter((index): index is number => index !== undefined);
    }

    return (this.parameters.indices as number[]).filter(
      (index) => index >= 0 && index < channels
    );
  }

  /**
   * The chosen channels, in the order asked for — or their mean, as one
   * channel. Nothing selected means nothing is emitted.
   */
  protected outputOptions(meta: StreamMetadata): EmitOptions | null {
    const indices = this.resolveIndices(meta, getStreamChannelCount(meta));
    if (indices.length === 0) return null;

    const info = meta.channelInfo;
    const shared: EmitOptions = {
      name: "selected",
      samplingRate: meta.samplingRate,
      samplesPerChannel: meta.samplesPerChannel,
    };

    if (this.parameters.average) {
      const label = info
        ? `Mean of ${indices.map((i) => info[i]?.label ?? i).join(", ")}`
        : "Mean";
      return {
        ...shared,
        channelInfo: [{ index: 0, label, unit: info?.[indices[0]]?.unit }],
      };
    }

    const channelInfo: ChannelInfo[] = indices.map((source, index) => ({
      index,
      label: info?.[source]?.label ?? `Channel ${source + 1}`,
      ...(info?.[source]?.unit ? { unit: info[source].unit } : {}),
    }));
    return { ...shared, channelInfo };
  }

  analyze(packet: DataPacket): DataPacket | null {
    const channels = getChannelCount(packet);
    const indices = this.resolveIndices(packet.metadata, channels);
    if (indices.length === 0) return null;

    const perChannel = deinterleave(packet.data, channels);
    const selected = indices.map((index) => perChannel[index]);

    if (this.parameters.average) {
      const samples = selected[0].length;
      const averaged = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (const channel of selected) sum += channel[i];
        averaged[i] = sum / selected.length;
      }
      return this.emitDeclared(packet, averaged);
    }

    return this.emitDeclared(packet, interleave(selected));
  }
}
