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
import { getChannelCount, getStreamChannelCount } from "../../../utility";
import { ParameterSchema } from "../../parameters";
import { SYNC_SCHEMA } from "../../base_analyzer";

export type MathOperation = "add" | "subtract" | "multiply" | "divide" | "power";

export interface MathParameters extends SyncParameters {
  /** How port `a` and port `b` combine, value by value. Defaults to `add`. */
  operation?: MathOperation;
  /** Take the absolute value of the result: an unsigned difference. */
  absolute?: boolean;
  /** Multiplies the result. Defaults to 1. */
  scale?: number;
  /** Added after `scale`. Defaults to 0. */
  offset?: number;
}

const OPERATIONS: Record<MathOperation, (x: number, y: number) => number> = {
  add: (x, y) => x + y,
  subtract: (x, y) => x - y,
  multiply: (x, y) => x * y,
  divide: (x, y) => x / y,
  power: (x, y) => x ** y,
};

/** Size of a pairing: a side with exactly one broadcasts against the other. */
function paired(x: number, y: number): number {
  return x === 1 || y === 1 ? Math.max(x, y) : Math.min(x, y);
}

/**
 * Arithmetic between two streams: `(a <operation> b)`, then optionally its
 * absolute value, then `* scale + offset`. TouchDesigner's Math CHOP.
 *
 * Values pair by channel index and sample index. Where one side has a single
 * channel, or a single sample, it is used against every one of the other's,
 * so a band can be divided by a total, or a waveform offset by a baseline.
 * Otherwise the shorter side decides how many are paired.
 *
 * The output keeps port `a`'s identity, rate and channel labels. Two people's
 * expression similarity, `1 - |a - b|`, is `subtract` with `absolute`, a
 * `scale` of -1 and an `offset` of 1.
 */
export class MathNode extends MultiInputAnalyzer {
  readonly name = "Math";
  readonly method = AnalysisMethod.MATH;
  readonly stage = ProcessingStage.PREPROCESSED;
  readonly ports = ["a", "b"];

  readonly accepts: Record<string, Accepts> = { a: {}, b: {} };

  static readonly schema: ParameterSchema = {
    operation: { type: "enum", options: Object.keys(OPERATIONS), default: "add" },
    absolute: { type: "boolean", default: false },
    scale: { type: "number", default: 1 },
    offset: { type: "number", default: 0 },
    ...SYNC_SCHEMA,
  };

  constructor(parameters: MathParameters = {}) {
    super(parameters);
    if (!(this.parameters.operation in OPERATIONS)) {
      throw new Error(
        `Unknown math operation "${this.parameters.operation}". ` +
          `Use one of: ${Object.keys(OPERATIONS).join(", ")}.`
      );
    }
  }

  protected outputOptions(inputs: Record<string, StreamMetadata>): EmitOptions {
    const { a, b } = inputs;
    const countA = getStreamChannelCount(a);
    const channels = paired(countA, getStreamChannelCount(b));
    const info = (countA === channels ? a : b).channelInfo;
    // Adding or subtracting keeps the unit; anything else changes it.
    const keepsUnit = ["add", "subtract"].includes(this.parameters.operation);

    const channelInfo: ChannelInfo[] = Array.from({ length: channels }, (_, c) => ({
      index: c,
      label: info?.[c]?.label ?? `channel ${c + 1}`,
      ...(keepsUnit && info?.[c]?.unit ? { unit: info[c].unit } : {}),
    }));

    return {
      name: "math",
      channelInfo,
      samplingRate: a.samplingRate,
      samplesPerChannel:
        a.samplesPerChannel !== undefined && b.samplesPerChannel !== undefined
          ? paired(a.samplesPerChannel, b.samplesPerChannel)
          : undefined,
    };
  }

  analyze(packets: Record<string, DataPacket>): DataPacket | null {
    const { a, b } = packets;
    if (!a || !b) return null;

    const channelsA = getChannelCount(a);
    const channelsB = getChannelCount(b);
    const samplesA = Math.floor(a.data.length / channelsA);
    const samplesB = Math.floor(b.data.length / channelsB);
    if (samplesA === 0 || samplesB === 0) return null;

    const channels = paired(channelsA, channelsB);
    const samples = paired(samplesA, samplesB);
    const combine = OPERATIONS[this.parameters.operation as MathOperation];
    const { absolute, scale, offset } = this.parameters;

    const out = new Float32Array(samples * channels);
    for (let i = 0; i < samples; i++) {
      const rowA = (samplesA === 1 ? 0 : i) * channelsA;
      const rowB = (samplesB === 1 ? 0 : i) * channelsB;
      for (let c = 0; c < channels; c++) {
        let value = combine(
          a.data[rowA + (channelsA === 1 ? 0 : c)],
          b.data[rowB + (channelsB === 1 ? 0 : c)]
        );
        if (absolute) value = Math.abs(value);
        out[i * channels + c] = value * scale + offset;
      }
    }

    return this.emitDeclared(packets, out);
  }
}
