import {
  FACE_API_68,
  FACE_API_68_OUTLINE,
  MEDIAPIPE_FACE_478,
  MEDIAPIPE_FACE_CONTOURS,
  MEDIAPIPE_FACE_MESH,
} from "./face_topology";
import {
  MEDIAPIPE_POSE_33,
  MEDIAPIPE_POSE_CONNECTIONS,
  POSE_LANDMARK_NAMES,
} from "./pose_topology";

/**
 * How much of a topology to draw: `"contours"` is the outline of its parts and
 * `"mesh"` the full triangulation, for the models that have one. A topology
 * with a single drawing ignores the choice.
 */
export type TopologyDetail = "contours" | "mesh";

/** @deprecated Use {@link TopologyDetail}; it is not specific to faces. */
export type FaceTopologyDetail = TopologyDetail;

/**
 * Edges for a named topology, or undefined for one this package does not know
 * — a stream from some other source, which then draws as points only.
 */
export function topologyEdges(
  topology: string | undefined,
  detail: TopologyDetail = "contours"
): readonly number[] | undefined {
  switch (topology) {
    case MEDIAPIPE_FACE_478:
      return detail === "mesh" ? MEDIAPIPE_FACE_MESH : MEDIAPIPE_FACE_CONTOURS;
    case FACE_API_68:
      return FACE_API_68_OUTLINE;
    case MEDIAPIPE_POSE_33:
      return MEDIAPIPE_POSE_CONNECTIONS;
    default:
      return undefined;
  }
}

/**
 * What each point of a named topology is called, in index order — or undefined
 * for a topology with no names, whose points are then only numbered. The face
 * models are in this group: 478 names would outweigh what they would label.
 */
export function topologyPointNames(
  topology: string | undefined
): readonly string[] | undefined {
  switch (topology) {
    case MEDIAPIPE_POSE_33:
      return POSE_LANDMARK_NAMES;
    default:
      return undefined;
  }
}
