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

/** Operations on two values: port `a` and port `b`, or `a` and the constant `b`. */
const BINARY = {
  add: (x: number, y: number) => x + y,
  subtract: (x: number, y: number) => x - y,
  multiply: (x: number, y: number) => x * y,
  divide: (x: number, y: number) => x / y,
  power: (x: number, y: number) => x ** y,
  minimum: Math.min,
  maximum: Math.max,
};

/** Operations on port `a` alone. */
const UNARY = {
  sign: Math.sign,
  reciprocal: (x: number) => 1 / x,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

/** `clamp` also takes `a` alone, between the `min` and `max` parameters. */
export type MathOperation = keyof typeof BINARY | keyof typeof UNARY | "clamp";

const OPERATIONS = [...Object.keys(BINARY), ...Object.keys(UNARY), "clamp"];

/** Operations whose result is in the same unit as their input. */
const KEEPS_UNIT = new Set(["add", "subtract", "minimum", "maximum", "floor", "ceil", "round", "clamp"]);

export interface MathParameters extends SyncParameters {
  /** What to compute. Defaults to `add`. */
  operation?: MathOperation;
  /**
   * A constant in place of port `b`, for the two-value operations. Left out,
   * the node has a `b` port and combines two streams.
   */
  b?: number;
  /** Lower bound for `clamp`. Left out, none. */
  min?: number;
  /** Upper bound for `clamp`. Left out, none. */
  max?: number;
  /** Take the absolute value of the result. */
  absolute?: boolean;
  /** Multiplies the result. Defaults to 1. */
  scale?: number;
  /** Added after `scale`. Defaults to 0. */
  offset?: number;
}

/** Size of a pairing: a side with exactly one broadcasts against the other. */
function paired(x: number, y: number): number {
  return x === 1 || y === 1 ? Math.max(x, y) : Math.min(x, y);
}

/**
 * Value-by-value math: the operation, then optionally its absolute value,
 * then `* scale + offset`. TouchDesigner's Math and Function CHOPs in one
 * node, as Blender's Math node is.
 *
 * A two-value operation (add, subtract, multiply, divide, power, minimum,
 * maximum) combines port `a` with port `b`, or with the constant `b` when one
 * is set, in which case the node has only port `a`. A one-value operation
 * (ln, sqrt, round, clamp, …) has only port `a`. Values outside an
 * operation's domain follow JavaScript's `Math`: the log of a negative number
 * is `NaN`.
 *
 * Between two streams, values pair by channel index and sample index. Where
 * one side has a single channel, or a single sample, it is used against every
 * one of the other's, so a band can be divided by a total. Otherwise the
 * shorter side decides how many are paired.
 *
 * The output keeps port `a`'s identity, rate and channel labels. Two people's
 * expression similarity, `1 - |a - b|`, is `subtract` with `absolute`, a
 * `scale` of -1 and an `offset` of 1. Frontal alpha asymmetry, ln(R) − ln(L),
 * is `divide` (right on `a`, left on `b`) followed by `ln`.
 */
export class MathNode extends MultiInputAnalyzer {
  readonly name = "Math";
  readonly method = AnalysisMethod.MATH;
  readonly stage = ProcessingStage.PREPROCESSED;

  readonly ports: string[];
  readonly accepts: Record<string, Accepts>;

  static readonly schema: ParameterSchema = {
    operation: { type: "enum", options: OPERATIONS, default: "add" },
    b: { type: "number", description: "A constant in place of port b. Left out, b is a port." },
    min: { type: "number", description: "Lower bound, for clamp. Left out, none." },
    max: { type: "number", description: "Upper bound, for clamp. Left out, none." },
    absolute: { type: "boolean", default: false },
    scale: { type: "number", default: 1 },
    offset: { type: "number", default: 0 },
    ...SYNC_SCHEMA,
  };

  constructor(parameters: MathParameters = {}) {
    super(parameters);
    const { operation, b, min, max } = this.parameters;
    if (!OPERATIONS.includes(operation)) {
      throw new Error(
        `Unknown math operation "${operation}". Use one of: ${OPERATIONS.join(", ")}.`
      );
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`Math min (${min}) is above its max (${max}).`);
    }
    this.ports = operation in BINARY && b === undefined ? ["a", "b"] : ["a"];
    this.accepts = Object.fromEntries(this.ports.map((port) => [port, {}]));
  }

  protected outputOptions(inputs: Record<string, StreamMetadata>): EmitOptions {
    const { a, b } = inputs;
    const countA = getStreamChannelCount(a);
    const channels = b ? paired(countA, getStreamChannelCount(b)) : countA;
    const info = (countA === channels || !b ? a : b).channelInfo;
    const keepsUnit = KEEPS_UNIT.has(this.parameters.operation);

    const channelInfo: ChannelInfo[] = Array.from({ length: channels }, (_, c) => ({
      index: c,
      label: info?.[c]?.label ?? `channel ${c + 1}`,
      ...(keepsUnit && info?.[c]?.unit ? { unit: info[c].unit } : {}),
    }));

    const samples = !b
      ? a.samplesPerChannel
      : a.samplesPerChannel !== undefined && b.samplesPerChannel !== undefined
      ? paired(a.samplesPerChannel, b.samplesPerChannel)
      : undefined;

    return {
      name: "math",
      channelInfo,
      samplingRate: a.samplingRate,
      samplesPerChannel: samples,
    };
  }

  analyze(packets: Record<string, DataPacket>): DataPacket | null {
    const { a } = packets;
    const b = this.ports.includes("b") ? packets.b : undefined;
    if (!a || (this.ports.includes("b") && !b)) return null;

    const channelsA = getChannelCount(a);
    const samplesA = Math.floor(a.data.length / channelsA);
    const channelsB = b ? getChannelCount(b) : 1;
    const samplesB = b ? Math.floor(b.data.length / channelsB) : 1;
    if (samplesA === 0 || samplesB === 0) return null;

    const channels = paired(channelsA, channelsB);
    const samples = paired(samplesA, samplesB);
    const { operation, absolute, scale, offset } = this.parameters;
    const binary = BINARY[operation as keyof typeof BINARY];
    const unary = UNARY[operation as keyof typeof UNARY];
    const constant = b ? undefined : Number(this.parameters.b);
    const min = this.parameters.min ?? -Infinity;
    const max = this.parameters.max ?? Infinity;

    const out = new Float32Array(samples * channels);
    for (let i = 0; i < samples; i++) {
      const rowA = (samplesA === 1 ? 0 : i) * channelsA;
      const rowB = (samplesB === 1 ? 0 : i) * channelsB;
      for (let c = 0; c < channels; c++) {
        const x = a.data[rowA + (channelsA === 1 ? 0 : c)];
        let value: number;
        if (binary) {
          const y = b ? b.data[rowB + (channelsB === 1 ? 0 : c)] : constant!;
          value = binary(x, y);
        } else if (operation === "clamp") {
          value = Math.min(max, Math.max(min, x));
        } else {
          value = unary(x);
        }
        if (absolute) value = Math.abs(value);
        out[i * channels + c] = value * scale + offset;
      }
    }

    return this.emitDeclared(packets, out);
  }
}
