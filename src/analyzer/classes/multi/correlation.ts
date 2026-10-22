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
} from "../../../utility";
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
 * shorter of the two windows. A window ends at its newest sample, so when the
 * lengths differ the longer one is trimmed from its oldest end: the samples
 * compared are the ones that overlap in time.
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

  /**
   * A correlation is taken across samples, so each input must carry a waveform
   * of at least two: a feature stream with one value per channel — band power,
   * say — has nothing to correlate and would never produce output.
   */
  readonly accepts: Record<string, Accepts> = {
    a: { minSamplesPerChannel: 2 },
    b: { minSamplesPerChannel: 2 },
  };

  /** One value per channel pair, or a single mean; always one sample each. */
  protected outputOptions(inputs: Record<string, StreamMetadata>): EmitOptions {
    const a = inputs.a;
    const b = inputs.b;
    const labelsA = a.channelInfo;
    const labelsB = b.channelInfo;
    const countA = getStreamChannelCount(a);
    const countB = getStreamChannelCount(b);
    const sources = [a.deviceInfo?.id ?? "A", b.deviceInfo?.id ?? "B"];
    const shared: EmitOptions = {
      name: "synchrony",
      samplingRate: this.cadenceOf(a),
      samplesPerChannel: 1,
    };

    if (this.parameters.mode === "mean") {
      return {
        ...shared,
        channelInfo: [{ index: 0, label: "Synchrony" }],
        additionalMetadata: { sources },
      };
    }

    const channelInfo: ChannelInfo[] = [];
    if (this.parameters.mode === "matrix") {
      for (let i = 0; i < countA; i++) {
        for (let j = 0; j < countB; j++) {
          channelInfo.push({
            index: channelInfo.length,
            label: `${labelsA?.[i]?.label ?? `A${i + 1}`} × ${
              labelsB?.[j]?.label ?? `B${j + 1}`
            }`,
          });
        }
      }
    } else {
      for (let i = 0; i < Math.min(countA, countB); i++) {
        channelInfo.push({
          index: i,
          label: `${labelsA?.[i]?.label ?? `Channel ${i + 1}`} synchrony`,
        });
      }
    }

    return {
      ...shared,
      channelInfo,
      additionalMetadata: { sources, mode: this.parameters.mode },
    };
  }

  analyze(packets: Record<string, DataPacket>): DataPacket | null {
    const a = packets.a;
    const b = packets.b;
    if (!a || !b) return null;

    let channelsA = deinterleave(a.data, getChannelCount(a));
    let channelsB = deinterleave(b.data, getChannelCount(b));
    if (channelsA.length === 0 || channelsB.length === 0) return null;

    const overlap = Math.min(channelsA[0].length, channelsB[0].length);
    if (overlap < 2) return null;
    channelsA = channelsA.map((x) => x.subarray(x.length - overlap));
    channelsB = channelsB.map((x) => x.subarray(x.length - overlap));

    const apply = (value: number) =>
      this.parameters.absolute ? Math.abs(value) : value;

    const values: number[] = [];

    if (this.parameters.mode === "matrix") {
      for (let i = 0; i < channelsA.length; i++) {
        for (let j = 0; j < channelsB.length; j++) {
          values.push(apply(correlation(channelsA[i], channelsB[j])));
        }
      }
    } else {
      const pairs = Math.min(channelsA.length, channelsB.length);
      for (let i = 0; i < pairs; i++) {
        values.push(apply(correlation(channelsA[i], channelsB[i])));
      }

      if (this.parameters.mode === "mean") {
        const average =
          values.length > 0
            ? values.reduce((x, y) => x + y, 0) / values.length
            : 0;
        return this.emitDeclared(packets, Float32Array.of(average));
      }
    }

    return this.emitDeclared(packets, Float32Array.from(values));
  }
}
