import {
  AnalysisMethod,
  ChannelInfo,
  DataPacket,
  ProcessingStage,
  StreamMetadata,
} from "../../../data_stream.interface";
import { Accepts, BaseAnalyzer, EmitOptions } from "../../base_analyzer";
import { ParameterSchema } from "../../parameters";

export type FunctionName =
  | "abs"
  | "negate"
  | "sign"
  | "reciprocal"
  | "sqrt"
  | "power"
  | "exp"
  | "ln"
  | "log10"
  | "log2"
  | "floor"
  | "ceil"
  | "round"
  | "sin"
  | "cos"
  | "tan";

export interface FunctionParameters {
  /** What to apply to every value. Defaults to `abs`. */
  function?: FunctionName;
  /** The exponent for `power`: each value raised to it. Defaults to 2. */
  exponent?: number;
}

const FUNCTIONS: Record<FunctionName, (x: number, exponent: number) => number> = {
  abs: Math.abs,
  negate: (x) => -x,
  sign: Math.sign,
  reciprocal: (x) => 1 / x,
  sqrt: Math.sqrt,
  power: (x, exponent) => x ** exponent,
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

/** Functions whose result is in the same unit as their input. */
const KEEPS_UNIT = new Set<FunctionName>(["abs", "negate", "floor", "ceil", "round"]);

/**
 * Applies one function to every value of a stream: TouchDesigner's Function
 * CHOP. Channels, rate and labels carry through.
 *
 * Values outside a function's domain follow JavaScript's `Math`: the log or
 * square root of a negative number is `NaN`, and the log of 0 is `-Infinity`.
 *
 * Frontal alpha asymmetry, ln(R) − ln(L), is a `math` node dividing right
 * alpha by left, then `ln`.
 */
export class FunctionNode extends BaseAnalyzer {
  readonly name = "Function";
  readonly method = AnalysisMethod.FUNCTION;
  readonly stage = ProcessingStage.PREPROCESSED;
  readonly accepts: Accepts = {};

  static readonly schema: ParameterSchema = {
    function: { type: "enum", options: Object.keys(FUNCTIONS), default: "abs" },
    exponent: { type: "number", default: 2, description: "For power." },
  };

  constructor(parameters: FunctionParameters = {}) {
    super(parameters);
    if (!(this.parameters.function in FUNCTIONS)) {
      throw new Error(
        `Unknown function "${this.parameters.function}". ` +
          `Use one of: ${Object.keys(FUNCTIONS).join(", ")}.`
      );
    }
  }

  protected outputOptions(meta: StreamMetadata): EmitOptions {
    const keepsUnit = KEEPS_UNIT.has(this.parameters.function);
    const channelInfo: ChannelInfo[] | undefined = meta.channelInfo?.map(
      ({ unit, ...channel }) => (keepsUnit && unit ? { ...channel, unit } : channel)
    );
    return {
      name: "function",
      channelInfo,
      samplingRate: meta.samplingRate,
      samplesPerChannel: meta.samplesPerChannel,
    };
  }

  analyze(packet: DataPacket): DataPacket | null {
    const apply = FUNCTIONS[this.parameters.function as FunctionName];
    const { exponent } = this.parameters;
    const out = new Float32Array(packet.data.length);
    for (let i = 0; i < out.length; i++) out[i] = apply(packet.data[i], exponent);
    return this.emitDeclared(packet, out);
  }
}
