import { Modality, ProcessingStage } from "../../../data_stream.interface";
import {
  VisionReceiver,
  VisionAssetOptions,
  DEFAULT_WASM_PATH,
} from "./base_vision";

const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

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

export interface PoseOptions extends VisionAssetOptions {
  /** People to track. */
  numPoses?: number;
  /** Include each landmark's visibility score as a fourth component. */
  includeVisibility?: boolean;
  /**
   * Emit metre-scale world coordinates centred on the hips instead of
   * image-normalized coordinates.
   *
   * World coordinates are what you want to drive anything physical, because
   * they do not change when the person moves toward or away from the camera.
   */
  worldCoordinates?: boolean;
}

/**
 * Body tracking via MediaPipe Pose Landmarker.
 *
 * Emits one stream of 33 landmarks flattened to x, y, z (and optionally
 * visibility) per landmark, with channels labelled "left wrist x" and so on.
 */
export class PoseReceiver extends VisionReceiver {
  deviceName = "Pose Detection";
  deviceID: string | number;

  private landmarker: any;
  private options: Required<
    Pick<PoseOptions, "numPoses" | "includeVisibility" | "worldCoordinates">
  >;
  private registered = new Set<string>();

  constructor(videoElement: HTMLVideoElement, options: PoseOptions = {}) {
    super(videoElement, options);
    this.deviceID = "pose";
    this.options = {
      numPoses: 1,
      includeVisibility: false,
      worldCoordinates: false,
      ...options,
    };
  }

  private get components(): string[] {
    return this.options.includeVisibility
      ? ["x", "y", "z", "visibility"]
      : ["x", "y", "z"];
  }

  protected async createTask(vision: any): Promise<void> {
    const { PoseLandmarker, FilesetResolver } = vision;

    const resolver = await FilesetResolver.forVisionTasks(
      this.assets.wasmPath ?? DEFAULT_WASM_PATH
    );

    this.landmarker = await PoseLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath: this.assets.modelAssetPath ?? DEFAULT_MODEL,
        delegate: this.assets.delegate,
      },
      runningMode: "VIDEO",
      numPoses: this.options.numPoses,
    });

    for (let i = 0; i < this.options.numPoses; i++) {
      this.registerStream(i);
    }
  }

  protected closeTask(): void {
    this.landmarker?.close?.();
    this.landmarker = undefined;
    this.registered.clear();
  }

  private streamName(pose: number): string {
    return this.options.numPoses > 1 ? `landmarks_pose_${pose + 1}` : "landmarks";
  }

  private registerStream(pose: number): void {
    const name = this.streamName(pose);
    if (this.registered.has(name)) return;

    const components = this.components;
    const channelInfo = [];
    let index = 0;
    for (const landmark of POSE_LANDMARK_NAMES) {
      for (const component of components) {
        channelInfo.push({ index: index++, label: `${landmark} ${component}` });
      }
    }

    this.initializeStream({
      modality: Modality.VIDEO,
      processingStage: ProcessingStage.INFERRED,
      name,
      additionalMetadata: {
        samplingRate: this.assets.maxFps,
        channelInfo,
        additionalMetadata: {
          coordinateSpace: this.options.worldCoordinates ? "world" : "image",
        },
      },
    });

    this.registered.add(name);
  }

  protected processFrame(timestampMs: number): void {
    if (!this.landmarker) return;

    const results = this.landmarker.detectForVideo(
      this.videoElement,
      timestampMs
    );
    const sets = this.options.worldCoordinates
      ? results?.worldLandmarks
      : results?.landmarks;
    if (!sets) return;

    const components = this.components;

    for (let pose = 0; pose < sets.length; pose++) {
      const points = sets[pose];
      if (!points || points.length === 0) continue;

      const flat = new Float32Array(POSE_LANDMARK_NAMES.length * components.length);
      for (let i = 0; i < POSE_LANDMARK_NAMES.length; i++) {
        const point = points[i];
        if (!point) continue;
        const base = i * components.length;
        flat[base] = point.x;
        flat[base + 1] = point.y;
        flat[base + 2] = point.z;
        if (this.options.includeVisibility) {
          flat[base + 3] = point.visibility ?? 0;
        }
      }

      this.update(
        {
          modality: Modality.VIDEO,
          processingStage: ProcessingStage.INFERRED,
          name: this.streamName(pose),
        },
        flat
      );
    }
  }
}
