/**
 * Fixed layout of MediaPipe's pose model, for naming and joining the points of
 * a `landmarks` stream. Like the face topologies, it belongs to the model and
 * never travels with the data; see `topology.ts` for the lookup.
 */

/** Topology name of MediaPipe Pose Landmarker's 33 body landmarks. */
export const MEDIAPIPE_POSE_33 = "mediapipe-pose-33";

/** The 33 body landmarks MediaPipe reports, in index order. */
export const POSE_LANDMARK_NAMES = [
  "nose",
  "left eye (inner)",
  "left eye",
  "left eye (outer)",
  "right eye (inner)",
  "right eye",
  "right eye (outer)",
  "left ear",
  "right ear",
  "mouth (left)",
  "mouth (right)",
  "left shoulder",
  "right shoulder",
  "left elbow",
  "right elbow",
  "left wrist",
  "right wrist",
  "left pinky",
  "right pinky",
  "left index",
  "right index",
  "left thumb",
  "right thumb",
  "left hip",
  "right hip",
  "left knee",
  "right knee",
  "left ankle",
  "right ankle",
  "left heel",
  "right heel",
  "left foot index",
  "right foot index",
];

/**
 * The skeleton MediaPipe draws (`POSE_CONNECTIONS`): face, arms, hands, torso,
 * legs and feet, as flattened pairs of landmark indices `[a0, b0, a1, b1, …]`.
 *
 * Copied from @mediapipe/tasks-vision, Apache License 2.0,
 * Copyright The MediaPipe Authors.
 */
export const MEDIAPIPE_POSE_CONNECTIONS: readonly number[] = [
  0, 1, 1, 2, 2, 3, 3, 7, 0, 4, 4, 5, 5, 6, 6, 8, 9, 10,
  11, 12, 11, 13, 13, 15, 15, 17, 15, 19, 15, 21, 17, 19,
  12, 14, 14, 16, 16, 18, 16, 20, 16, 22, 18, 20,
  11, 23, 12, 24, 23, 24, 23, 25, 24, 26, 25, 27, 26, 28,
  27, 29, 28, 30, 29, 31, 30, 32, 27, 31, 28, 32,
];
