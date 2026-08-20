import {
  AnalysisMethod,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { BaseAnalyzer } from "../../base_analyzer";
import { getChannelCount, interleave, deinterleave } from "../../../utility";
import {
  Biquad,
  FilterKind,
  designFilter,
  applyCascade,
  filtfiltCascade,
} from "../../methods/filter";

export interface FilteringParameters {
  kind?: FilterKind;
  /** Cutoff in Hz; `[low, high]` for band filters. */
  cutoff?: number | [number, number];
  /** Butterworth order. Rounded to an even number of biquad sections. */
  order?: number;
  /**
   * Run the filter forwards and backwards for zero phase distortion.
   *
   * Only valid on windowed input — it needs the whole segment at once and
   * cannot carry state between packets. On a continuous stream leave this off,
   * which keeps per-section state across packets so there is no discontinuity
   * at packet boundaries.
   */
  zeroPhase?: boolean;
}

/**
 * Butterworth filtering, applied per channel.
 *
 * On a continuous stream the filter keeps its delay-line state between
 * packets; a naive per-packet filter would re-run its transient on every chunk
 * and inject a click at each boundary, which at Muse's 12-sample chunks means
 * 21 clicks a second.
 */
export class Filtering extends BaseAnalyzer {
  readonly name = "Filtering";
  readonly method = AnalysisMethod.FILTERING;
  readonly stage = ProcessingStage.PREPROCESSED;

  private sections: Biquad[] | null = null;
  private designedFor: { rate: number; channels: number } | null = null;
  private states: Array<Array<{ x: number[]; y: number[] }>> = [];

  constructor(parameters: FilteringParameters = {}) {
    super({
      kind: "bandpass",
      cutoff: [1, 40],
      order: 4,
      zeroPhase: false,
      ...parameters,
    });
  }

  compatible(meta: StreamMetadata): boolean {
    return meta.samplingRate !== undefined && meta.samplingRate > 0;
  }

  public reset(): void {
    this.sections = null;
    this.designedFor = null;
    this.states = [];
  }

  private ensureDesign(rate: number, channels: number): Biquad[] {
    if (
      this.sections &&
      this.designedFor &&
      this.designedFor.rate === rate &&
      this.designedFor.channels === channels
    ) {
      return this.sections;
    }

    this.sections = designFilter({
      kind: this.parameters.kind,
      cutoff: this.parameters.cutoff,
      samplingRate: rate,
      order: this.parameters.order,
    });
    this.designedFor = { rate, channels };
    this.states = Array.from({ length: channels }, () =>
      this.sections!.map(() => ({ x: [] as number[], y: [] as number[] }))
    );

    return this.sections;
  }

  analyze(packet: DataPacket): DataPacket | null {
    const rate = packet.metadata.samplingRate;
    if (!rate) return null;

    const channels = getChannelCount(packet);
    const sections = this.ensureDesign(rate, channels);
    const perChannel = deinterleave(packet.data, channels);

    const filtered = perChannel.map((signal, index) =>
      this.parameters.zeroPhase
        ? filtfiltCascade(sections, signal)
        : applyCascade(sections, signal, this.states[index])
    );

    return this.emit(packet, interleave(filtered), {
      name: `${this.parameters.kind}`,
      samplingRate: rate,
    });
  }
}
