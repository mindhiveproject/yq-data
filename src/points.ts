import { StreamMetadata } from "./data_stream.interface";
import { topologyPointNames } from "./draw/topology";

/**
 * Helpers for streams of points — face landmarks, body pose, anything whose
 * packet is `[x0, y0, z0, x1, …]` — shared by the receivers that write them and
 * the code that reads them, so a face and a body are described, labelled and
 * measured the same way.
 */

/**
 * What a point's coordinates are relative to: `"image"` is 0–1 across the video
 * frame, x right and y down, so it can be drawn over the video; `"world"` is
 * metric and body-centred, which cannot.
 */
export type PointCoordinateSpace = "image" | "world";

/**
 * Layout of a stream of `count` points flattened to `components` each, as in
 * `[x0, y0, z0, x1, …]`.
 *
 * Deliberately not one `channelInfo` entry per value: for the 478-point face
 * mesh that is 43 KB of labels, re-announced to every network consumer every
 * few seconds. `pointComponents` gives the stride in a few bytes, and
 * `topology` names the model the points come from so a reader can look up what
 * they are called and how they connect (see `topologyPointNames` and
 * `topologyEdges`).
 */
export function pointStreamMetadata(
  count: number,
  components: string[],
  topology: string,
  coordinateSpace: PointCoordinateSpace = "image"
): Partial<StreamMetadata> {
  return {
    channelCount: count * components.length,
    additionalMetadata: {
      pointComponents: components,
      topology,
      coordinateSpace,
    },
  };
}

/**
 * Components per point in a point stream: from `pointComponents` when the
 * source declared it, else from channel labels like "nose x" (older streams),
 * else 3.
 */
export function pointStride(
  metadata: Pick<StreamMetadata, "channelInfo" | "additionalMetadata">
): number {
  const components = metadata.additionalMetadata?.pointComponents;
  if (Array.isArray(components) && components.length > 0) return components.length;
  const info = metadata.channelInfo;
  const second = info?.findIndex((c, i) => i > 0 && c.label.endsWith(" x"));
  return second !== undefined && second > 0 ? second : 3;
}

/** One point of a point stream and where its values sit in a packet. */
export interface PointGroup {
  /** The point's name, e.g. "left wrist"; "point 12" when the topology has no names. */
  label: string;
  /** Positions of the point's components in the flattened data, in component order. */
  indices: number[];
}

/**
 * The points of a stream built with `pointStreamMetadata`, each with the
 * packet indices of its components: `[{ label: "nose", indices: [0, 1, 2] }, …]`.
 *
 * This is the labelling that one `channelInfo` entry per value used to carry,
 * rebuilt from the stride and topology the metadata does carry. A stream that
 * declares no `pointComponents` is not a point stream and has no groups.
 */
export function pointChannelGroups(
  metadata: Pick<StreamMetadata, "channelCount" | "additionalMetadata">
): PointGroup[] {
  const components = metadata.additionalMetadata?.pointComponents;
  if (!Array.isArray(components) || components.length === 0) return [];

  const stride = components.length;
  const names = topologyPointNames(metadata.additionalMetadata?.topology);
  const count = Math.floor((metadata.channelCount ?? 0) / stride);

  return Array.from({ length: count }, (_, point) => ({
    label: names?.[point] ?? `point ${point}`,
    indices: Array.from({ length: stride }, (_, c) => point * stride + c),
  }));
}

/**
 * Flattens a tracker's points to the packet layout `pointStreamMetadata`
 * declares: one value per name in `components`, point after point. A component
 * the point lacks is 0.
 *
 * `frame` divides x and y by a size in pixels, for a tracker that reports
 * pixels rather than 0–1.
 */
export function flattenPoints(
  points: ReadonlyArray<Record<string, number | undefined>>,
  components: readonly string[],
  frame?: { width: number; height: number }
): Float32Array {
  const stride = components.length;
  const flat = new Float32Array(points.length * stride);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!point) continue;
    for (let c = 0; c < stride; c++) {
      const name = components[c];
      let value = point[name] ?? 0;
      if (frame && name === "x") value /= frame.width;
      else if (frame && name === "y") value /= frame.height;
      flat[i * stride + c] = value;
    }
  }
  return flat;
}

/** A box in the units of the points it surrounds. */
export interface PointBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tightest box around the x and y of every point in flattened `data`, or
 * undefined when there are none.
 */
export function pointBounds(
  data: ArrayLike<number>,
  stride: number
): PointBounds | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < data.length; i += stride) {
    const x = data[i];
    const y = data[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX > maxX) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
