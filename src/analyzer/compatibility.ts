import { AnalysisMethod, StreamMetadata } from "../data_stream.interface";
import { Accepts, AnyAnalyzer, isMultiInput } from "./base_analyzer";
import { createAnalyzer } from "./registry";
import { getValueType } from "../utility";

/**
 * The result of a compatibility check: `true`, or the reason it failed.
 *
 * A reason rather than a bare `false` because every caller has someone to tell
 * — a pipeline writing to `onError`, a node editor explaining a refused edge.
 */
export type Compatibility = true | string;

/**
 * Checks one stream against one input's requirements.
 *
 * Pure and synchronous: it reads metadata and a descriptor, touching no
 * packets, so a UI can call it while the user is still dragging the edge.
 */
export function checkAccepts(
  accepts: Accepts,
  meta: StreamMetadata
): Compatibility {
  const valueType = getValueType(meta);
  const acceptedTypes = accepts.valueTypes ?? ["numeric"];
  if (!acceptedTypes.includes(valueType)) {
    return valueType === "categorical"
      ? `stream "${meta.streamID}" carries labels rather than measurements, which this node cannot interpret`
      : `stream "${meta.streamID}" carries ${valueType} values, and this node accepts only ${acceptedTypes.join(
          ", "
        )}`;
  }

  if (
    accepts.requiresSamplingRate &&
    !(meta.samplingRate !== undefined && meta.samplingRate > 0)
  ) {
    return `stream "${meta.streamID}" has no sampling rate, and this node needs a regularly sampled signal`;
  }

  if (accepts.modalities && !accepts.modalities.includes(meta.modality)) {
    return `stream "${meta.streamID}" is ${
      meta.modality
    }, and this node accepts only ${accepts.modalities.join(", ")}`;
  }

  return true;
}

/** The descriptor for one input port of an already-built analyzer. */
export function acceptsFor(
  analyzer: AnyAnalyzer,
  port?: string
): Accepts | undefined {
  if (!isMultiInput(analyzer)) return analyzer.accepts;
  return analyzer.accepts[port ?? analyzer.primaryPort];
}

/**
 * Whether a stream may feed a given analysis method.
 *
 * The question a node editor asks before drawing an edge. Building the
 * analyzer is what makes a parameter-dependent rule answerable — windowing
 * accepts an irregular stream when its size is in samples and rejects it when
 * the size is in seconds — and construction is cheap enough to do per query.
 *
 * ```ts
 * canConnect(markerStream.metadata, AnalysisMethod.BAND_POWER);
 * //=> 'stream "markers:event_marker:raw" carries labels rather than ...'
 * ```
 */
export function canConnect(
  meta: StreamMetadata,
  method: AnalysisMethod | string,
  parameters: Record<string, any> = {},
  port?: string
): Compatibility {
  let analyzer: AnyAnalyzer;
  try {
    analyzer = createAnalyzer(method, parameters);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const accepts = acceptsFor(analyzer, port);
  if (!accepts) {
    const ports = isMultiInput(analyzer) ? Object.keys(analyzer.accepts) : [];
    return `"${method}" has no input port named "${port}"${
      ports.length ? ` (expected one of: ${ports.join(", ")})` : ""
    }`;
  }

  return checkAccepts(accepts, meta);
}

/**
 * Every method that would accept this stream.
 *
 * The list a node editor offers when someone drags out from an output — the
 * inverse of {@link canConnect}, and the reason the descriptors are worth
 * having as data rather than as predicates.
 */
export function compatibleMethods(
  meta: StreamMetadata,
  methods: string[]
): string[] {
  return methods.filter((method) => canConnect(meta, method) === true);
}
