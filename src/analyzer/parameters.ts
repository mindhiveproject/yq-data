/**
 * What kind of value a parameter holds.
 *
 * - `number`, `integer`: a number; `min` and `max` bound it.
 * - `boolean`.
 * - `string`: text, such as an address.
 * - `enum`: one of `options`.
 * - `numbers`: a number or a list of numbers, such as a filter's cutoff
 *   (`10` or `[1, 40]`); `min` and `max` bound each one.
 * - `json`: any value that survives JSON (band definitions, stream lists).
 *   Not checked.
 */
export type ParameterType =
  | "number"
  | "integer"
  | "boolean"
  | "string"
  | "enum"
  | "numbers"
  | "json";

/**
 * One parameter of a method or a receiver: what it takes, what it defaults to, and its
 * range. Plain JSON, so a node editor or a settings panel can draw a control
 * for it without knowing the method.
 */
export interface ParameterSpec {
  type: ParameterType;
  /** Used when a node does not set the parameter. Absent means the method works it out. */
  default?: unknown;
  /** Smallest value allowed, for number types. */
  min?: number;
  /** Largest value allowed, for number types. */
  max?: number;
  /** Allowed values, for `enum`. */
  options?: ReadonlyArray<string | number | boolean>;
  unit?: string;
  label?: string;
  description?: string;
}

/** Every parameter of a method or receiver, by the name its node or options use. */
export type ParameterSchema = Record<string, ParameterSpec>;

/** The schema's defaults, as an analyzer's starting parameters. */
export function defaultsOf(schema: ParameterSchema | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema ?? {})) {
    if (spec.default !== undefined) defaults[name] = spec.default;
  }
  return defaults;
}

/** Why `value` does not fit `spec`, or undefined when it does. */
export function checkParameter(spec: ParameterSpec, value: unknown): string | undefined {
  const inRange = (n: number): string | undefined => {
    if (spec.min !== undefined && n < spec.min) return `${n} is below the minimum of ${spec.min}`;
    if (spec.max !== undefined && n > spec.max) return `${n} is above the maximum of ${spec.max}`;
    return undefined;
  };
  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  switch (spec.type) {
    case "number":
      return isNumber(value) ? inRange(value) : "expected a number";
    case "integer":
      return Number.isInteger(value) ? inRange(value as number) : "expected a whole number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected true or false";
    case "string":
      return typeof value === "string" ? undefined : "expected text";
    case "enum":
      return spec.options?.includes(value as string) ?? true
        ? undefined
        : `expected one of ${spec.options!.map((o) => JSON.stringify(o)).join(", ")}`;
    case "numbers": {
      const list = Array.isArray(value) ? value : [value];
      if (!list.every(isNumber)) return "expected a number or a list of numbers";
      for (const n of list) {
        const reason = inRange(n);
        if (reason) return reason;
      }
      return undefined;
    }
    case "json":
      return undefined;
  }
}

/**
 * Stands in for a value in a node's `parameters`, naming one of the graph's
 * {@link PipelineGraph.parameters} to read it from.
 *
 * `{ "size": { "$parameter": "windowSize" } }`
 */
export interface ParameterReference {
  $parameter: string;
}

/** Whether a node parameter value is a {@link ParameterReference}. */
export function isParameterReference(value: unknown): value is ParameterReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ParameterReference).$parameter === "string"
  );
}

/**
 * A parameter the graph exposes, as stored in `graph.parameters`.
 *
 * Every field is optional: what is left out comes from the schema of the
 * method that reads it, so `{ "label": "Window" }` is a window size with the
 * windowing node's type, default and range. What is given narrows it, for
 * this graph: a `min` and `max` here are the range a study may choose from.
 */
export type GraphParameter = Partial<ParameterSpec>;
