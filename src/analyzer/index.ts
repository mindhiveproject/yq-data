/**
 * Analysis module exports.
 *
 * Three layers, deliberately separable:
 * - `methods/` — pure DSP over plain arrays, no packets involved.
 * - `classes/` — packet-aware nodes wrapping those methods.
 * - `registry` — the method-name to class mapping that lets a graph be JSON.
 */

export {
  AbstractAnalyzer,
  BaseAnalyzer,
  MultiInputAnalyzer,
  isMultiInput,
} from "./base_analyzer";
export type {
  Accepts,
  AnyAnalyzer,
  SyncPolicy,
  SyncParameters,
  EmitOptions,
} from "./base_analyzer";

export * from "./compatibility";

export * from "./methods";
export * from "./classes";
export * from "./registry";
