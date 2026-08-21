import { AnalysisMethod } from "../data_stream.interface";
import { AnyAnalyzer } from "./base_analyzer";

import { Windowing } from "./classes/preprocessing/windowing";
import { Filtering } from "./classes/preprocessing/filtering";
import { Normalization } from "./classes/preprocessing/normalization";
import { ChannelSelection } from "./classes/preprocessing/channel_selection";
import { SpectrumAnalyzer } from "./classes/transform/spectrum";
import { BandPower } from "./classes/features/band_power";
import {
  StatisticalFeatures,
  RMSAnalyzer,
} from "./classes/features/statistics";
import { HeartRate } from "./classes/features/heart_rate";
import { Correlation } from "./classes/multi/correlation";
import { Difference } from "./classes/multi/difference";

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

/** Registers (or replaces) the implementation of an analysis method. */
export function registerAnalyzer(
  method: AnalysisMethod | string,
  factory: AnalyzerFactory
): void {
  registry.set(method, factory);
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

registerAnalyzer(AnalysisMethod.WINDOWING, (p) => new Windowing(p));
registerAnalyzer(AnalysisMethod.FILTERING, (p) => new Filtering(p));
registerAnalyzer(AnalysisMethod.NORMALIZATION, (p) => new Normalization(p));
registerAnalyzer(
  AnalysisMethod.CHANNEL_SELECTION,
  (p) => new ChannelSelection(p)
);
registerAnalyzer(AnalysisMethod.FFT, (p) => new SpectrumAnalyzer(p));
registerAnalyzer(AnalysisMethod.PSD, (p) => new SpectrumAnalyzer(p));
registerAnalyzer(AnalysisMethod.BAND_POWER, (p) => new BandPower(p));
registerAnalyzer(
  AnalysisMethod.STATISTICAL_FEATURES,
  (p) => new StatisticalFeatures(p)
);
registerAnalyzer(AnalysisMethod.RMS, (p) => new RMSAnalyzer(p));
registerAnalyzer(AnalysisMethod.HEART_RATE, (p) => new HeartRate(p));
registerAnalyzer(AnalysisMethod.CONNECTIVITY, (p) => new Correlation(p));
registerAnalyzer("difference", (p) => new Difference(p));
