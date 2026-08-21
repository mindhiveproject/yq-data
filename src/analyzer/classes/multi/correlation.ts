import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { MultiInputAnalyzer, SyncParameters } from "../../base_analyzer";
import { getChannelCount, deinterleave } from "../../../utility";
import { correlation } from "../../methods/stats";

export interface CorrelationParameters extends SyncParameters {
  /**
   * `paired` correlates channel *i* of A with channel *i* of B — two people
   * wearing the same headset model. `matrix` correlates every channel of A
   * with every channel of B.
   */
  mode?: "paired" | "matrix" | "mean";
  /** Report |r| rather than signed r. */
  absolute?: boolean;
}

/**
 * Correlation between two streams.
 *
 * Both inputs must be windowed, and the correlation is computed over the
 * shorter of the two windows.
 *
 * Pairing is left on the default `latest` policy. The stricter `timestamp`
 * and `nearest` policies are available, but note what they can and cannot buy
 * here: a packet carries one timestamp for a whole window, so matching two
 * windows to the millisecond still leaves their samples on separate time
 * grids whenever the streams run at different rates, and this node zips them
 * index to index regardless. Gating harder mainly costs output rate. Genuine
 * alignment needs resampling one stream onto the other's grid upstream, or a
 * lagged cross-correlation that measures the offset instead of assuming it
 * away.
 */
export class Correlation extends MultiInputAnalyzer {
  readonly name = "Correlation";
  readonly method = AnalysisMethod.CONNECTIVITY;
  readonly stage = ProcessingStage.FEATURES;
  readonly ports = ["a", "b"];

  constructor(parameters: CorrelationParameters = {}) {
    super({ mode: "paired", absolute: false, ...parameters });
  }

  compatible(metas: Record<string, StreamMetadata>): boolean {
    return Boolean(metas.a && metas.b);
  }

  analyze(packets: Record<string, DataPacket>): DataPacket | null {
    const a = packets.a;
    const b = packets.b;
    if (!a || !b) return null;

    const channelsA = deinterleave(a.data, getChannelCount(a));
    const channelsB = deinterleave(b.data, getChannelCount(b));
    if (channelsA.length === 0 || channelsB.length === 0) return null;
    if (channelsA[0].length < 2 || channelsB[0].length < 2) return null;

    const labelsA = a.metadata.channelInfo;
    const labelsB = b.metadata.channelInfo;
    const nameA = a.metadata.deviceInfo?.id ?? "A";
    const nameB = b.metadata.deviceInfo?.id ?? "B";

    const apply = (value: number) =>
      this.parameters.absolute ? Math.abs(value) : value;

    const values: number[] = [];
    const channelInfo: ChannelInfo[] = [];

    if (this.parameters.mode === "matrix") {
      for (let i = 0; i < channelsA.length; i++) {
        for (let j = 0; j < channelsB.length; j++) {
          channelInfo.push({
            index: values.length,
            label: `${labelsA?.[i]?.label ?? `A${i + 1}`} × ${
              labelsB?.[j]?.label ?? `B${j + 1}`
            }`,
          });
          values.push(apply(correlation(channelsA[i], channelsB[j])));
        }
      }
    } else {
      const pairs = Math.min(channelsA.length, channelsB.length);
      for (let i = 0; i < pairs; i++) {
        channelInfo.push({
          index: i,
          label: `${labelsA?.[i]?.label ?? `Channel ${i + 1}`} synchrony`,
        });
        values.push(apply(correlation(channelsA[i], channelsB[i])));
      }

      if (this.parameters.mode === "mean") {
        const average =
          values.length > 0
            ? values.reduce((x, y) => x + y, 0) / values.length
            : 0;
        return this.emit(a, Float32Array.of(average), {
          name: "synchrony",
          channelInfo: [{ index: 0, label: "Synchrony" }],
          samplingRate: a.metadata.additionalMetadata?.packetRate,
          additionalMetadata: { sources: [nameA, nameB] },
        });
      }
    }

    return this.emit(a, Float32Array.from(values), {
      name: "synchrony",
      channelInfo,
      samplingRate: a.metadata.additionalMetadata?.packetRate,
      additionalMetadata: { sources: [nameA, nameB], mode: this.parameters.mode },
    });
  }
}
