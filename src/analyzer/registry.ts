import { AnalysisMethod } from "../data_stream.interface";
import { AnyAnalyzer } from "./base_analyzer";
import { ParameterSchema } from "./parameters";

import { Windowing } from "./classes/preprocessing/windowing";
import { Filtering } from "./classes/preprocessing/filtering";
import { Normalization } from "./classes/preprocessing/normalization";
import { ChannelSelection } from "./classes/preprocessing/channel_selection";
import { SpectrumAnalyzer } from "./classes/transform/spectrum";
import { PulseExtraction } from "./classes/transform/pulse_extraction";
import { BandPower } from "./classes/features/band_power";
import {
  StatisticalFeatures,
  RMSAnalyzer,
} from "./classes/features/statistics";
import { HeartRate } from "./classes/features/heart_rate";
import { Correlation } from "./classes/multi/correlation";
import { MathNode } from "./classes/math/math";
import { Lag } from "./classes/math/lag";
import { StreamSelection } from "./classes/routing/stream_selection";
import { Merge } from "./classes/routing/merge";

/** Constructs an analyzer from a plain parameter object. */
export type AnalyzerFactory = (parameters: Record<string, any>) => AnyAnalyzer;

/**
 * Maps an analysis method name to the class that implements it.
 *
 * This indirection is what lets a pipeline be described as plain JSON — a
 * stored data-source block names its nodes by method string, and the registry
 * turns them into live objects. Built-in and user-authored blocks therefore
 * execute through exactly the same evaluator.
 */
const registry = new Map<string, AnalyzerFactory>();
const schemas = new Map<string, ParameterSchema>();

/**
 * Registers (or replaces) the implementation of an analysis method, with the
 * schema of the parameters it takes. A method registered without one takes
 * its parameters unchecked.
 */
export function registerAnalyzer(
  method: AnalysisMethod | string,
  factory: AnalyzerFactory,
  schema?: ParameterSchema
): void {
  registry.set(method, factory);
  if (schema) schemas.set(method, schema);
  else schemas.delete(method);
}

/** The parameters a method takes — type, default and range of each — if it declares them. */
export function parameterSchema(
  method: AnalysisMethod | string
): ParameterSchema | undefined {
  return schemas.get(method);
}

/** Looks up a factory without constructing anything. */
export function getAnalyzerFactory(
  method: AnalysisMethod | string
): AnalyzerFactory | undefined {
  return registry.get(method);
}

/** Every method name currently registered. */
export function registeredMethods(): string[] {
  return Array.from(registry.keys());
}

/**
 * Builds an analyzer for a method.
 *
 * @throws when the method has no registered implementation, listing what is
 * available — a graph referencing an unknown node should fail loudly at
 * construction rather than silently dropping a branch at runtime.
 */
export function createAnalyzer(
  method: AnalysisMethod | string,
  parameters: Record<string, any> = {}
): AnyAnalyzer {
  const factory = registry.get(method);
  if (!factory) {
    throw new Error(
      `No analyzer registered for method "${method}". Registered methods: ${registeredMethods().join(
        ", "
      )}`
    );
  }
  return factory(parameters);
}

registerAnalyzer(AnalysisMethod.WINDOWING, (p) => new Windowing(p), Windowing.schema);
registerAnalyzer(AnalysisMethod.FILTERING, (p) => new Filtering(p), Filtering.schema);
registerAnalyzer(AnalysisMethod.NORMALIZATION, (p) => new Normalization(p), Normalization.schema);
registerAnalyzer(AnalysisMethod.CHANNEL_SELECTION, (p) => new ChannelSelection(p), ChannelSelection.schema);
registerAnalyzer(AnalysisMethod.FFT, (p) => new SpectrumAnalyzer(p), SpectrumAnalyzer.schema);
registerAnalyzer(AnalysisMethod.PSD, (p) => new SpectrumAnalyzer(p), SpectrumAnalyzer.schema);
registerAnalyzer(AnalysisMethod.PULSE_EXTRACTION, (p) => new PulseExtraction(p), PulseExtraction.schema);
registerAnalyzer(AnalysisMethod.BAND_POWER, (p) => new BandPower(p), BandPower.schema);
registerAnalyzer(AnalysisMethod.STATISTICAL_FEATURES, (p) => new StatisticalFeatures(p), StatisticalFeatures.schema);
registerAnalyzer(AnalysisMethod.RMS, (p) => new RMSAnalyzer(p), RMSAnalyzer.schema);
registerAnalyzer(AnalysisMethod.HEART_RATE, (p) => new HeartRate(p), HeartRate.schema);
registerAnalyzer(AnalysisMethod.CONNECTIVITY, (p) => new Correlation(p), Correlation.schema);
registerAnalyzer(AnalysisMethod.MATH, (p) => new MathNode(p), MathNode.schema);
registerAnalyzer(AnalysisMethod.LAG, (p) => new Lag(p), Lag.schema);
registerAnalyzer(AnalysisMethod.STREAM_SELECTION, (p) => new StreamSelection(p), StreamSelection.schema);
registerAnalyzer(AnalysisMethod.MERGE, (p) => new Merge(p), Merge.schema);
