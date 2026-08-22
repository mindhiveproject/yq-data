import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import {
  Accepts,
  MultiInputAnalyzer,
  SyncParameters,
} from "../../base_analyzer";
import { getChannelCount, deinterleave, interleave } from "../../../utility";

/** Upper bound on ports, so the letter naming stays unambiguous. */
const MAX_INPUTS = 26;

export interface MergeParameters extends SyncParameters {
  /** How many input ports to expose. Two to twenty-six; named `a`, `b`, `c`, … */
  inputs?: number;
  /**
   * Whether to prefix each channel label with the stream it came from.
   *
   * `"auto"` prefixes only the labels that would otherwise collide, so merging
   * two Muse headsets gives `muse-a AF7` and `muse-b AF7` while merging band
   * power with a heart rate leaves `Alpha` and `BPM` alone.
   */
  prefixLabels?: boolean | "auto";
}

/** Short, human-readable tag for the stream a channel came from. */
function sourceTag(meta: StreamMetadata, fallback: string): string {
  return meta.name || String(meta.deviceInfo?.id ?? fallback);
}

/**
 * Combines several streams into one multi-channel stream.
 *
 * The counterpart to {@link StreamSelection}, and the node that lets a graph
 * converge: band power, heart rate and a facial expression score arriving on
 * three wires become one packet with three channels, which is the shape
 * anything reading the graph's output — a recorder, a table, a set of bindings
 * in a visual — would otherwise have to reassemble itself.
 *
 * ```ts
 * { id: "bundle", method: "merge", parameters: { inputs: 3 } },
 * // edges: … to: ["bundle", "a"], ["bundle", "b"], ["bundle", "c"]
 * ```
 *
 * Channels are concatenated in port order. Where the ports disagree about how
 * many samples they carry, the merged packet is truncated to the shortest —
 * merging streams of different lengths zips them index to index, which is only
 * meaningful for feature streams carrying one sample per channel. Waveforms at
 * different rates should be resampled or windowed to a common cadence first.
 *
 * The output declares a sampling rate only when every input that has one
 * agrees, and a modality only when every input shares it. Both absences are
 * load-bearing: a merged stream with no rate is correctly refused by every
 * rate-dependent node downstream, rather than being filtered at a rate that
 * describes none of its channels.
 */
export class Merge extends MultiInputAnalyzer {
  readonly name = "Merge";
  readonly method = AnalysisMethod.MERGE;
  readonly stage = ProcessingStage.PREPROCESSED;

  readonly ports: string[];
  readonly accepts: Record<string, Accepts>;

  constructor(parameters: MergeParameters = {}) {
    super({ inputs: 2, prefixLabels: "auto", ...parameters });

    const requested = Math.floor(Number(this.parameters.inputs) || 2);
    const count = Math.min(MAX_INPUTS, Math.max(2, requested));

    this.ports = Array.from({ length: count }, (_, i) =>
      String.fromCharCode(97 + i)
    );

    // Numeric only, on every port. Concatenating a marker code into a block of
    // measurements would hand downstream nodes a channel they cannot tell is
    // not a measurement — route markers with `stream_selection` instead.
    this.accepts = Object.fromEntries(this.ports.map((port) => [port, {}]));
  }

  /** The one value every input agrees on, or undefined if they differ. */
  private consensus<T>(values: Array<T | undefined>): T | undefined {
    const defined = values.filter((v): v is T => v !== undefined);
    if (defined.length === 0) return undefined;
    return defined.every((v) => v === defined[0]) ? defined[0] : undefined;
  }

  analyze(packets: Record<string, DataPacket>): DataPacket | null {
    const inputs = this.ports.map((port) => packets[port]);
    if (inputs.some((packet) => !packet)) return null;

    const channels: Float32Array[] = [];
    const labels: string[] = [];
    const tags: string[] = [];
    const units: Array<string | undefined> = [];

    inputs.forEach((packet, portIndex) => {
      const perChannel = deinterleave(packet.data, getChannelCount(packet));
      const info = packet.metadata.channelInfo;
      const tag = sourceTag(packet.metadata, this.ports[portIndex]);

      perChannel.forEach((channel, index) => {
        channels.push(channel);
        labels.push(info?.[index]?.label ?? `Channel ${index + 1}`);
        tags.push(tag);
        units.push(info?.[index]?.unit);
      });
    });

    if (channels.length === 0) return null;

    const channelInfo: ChannelInfo[] = labels.map((label, index) => ({
      index,
      label: this.labelFor(label, tags[index], labels),
      ...(units[index] ? { unit: units[index] } : {}),
    }));

    const rate = this.consensus(
      inputs.map((packet) => packet.metadata.samplingRate)
    );
    const modality = this.consensus(
      inputs.map((packet) => packet.metadata.modality)
    );

    return this.emit(inputs[0], interleave(channels), {
      name: "merged",
      modality: modality ?? Modality.UNKNOWN,
      channelInfo,
      // `null` clears the rate inherited from port a, which describes only
      // port a's channels once the inputs disagree.
      samplingRate: rate ?? null,
      additionalMetadata: {
        sources: inputs.map((packet) => packet.streamID),
      },
    });
  }

  /** Applies the label-prefixing policy to one channel. */
  private labelFor(label: string, tag: string, all: string[]): string {
    const policy = this.parameters.prefixLabels;
    if (policy === false) return label;
    if (policy === true) return `${tag} ${label}`;

    const collides = all.filter((other) => other === label).length > 1;
    return collides ? `${tag} ${label}` : label;
  }
}
