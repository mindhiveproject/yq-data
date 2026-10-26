import { Modality, ProcessingStage } from "../../../data_stream.interface";
import {
  MEDIAPIPE_POSE_33,
  POSE_LANDMARK_NAMES,
} from "../../../draw/pose_topology";
import { flattenPoints, pointStreamMetadata } from "../../../points";
import {
  VisionReceiver,
  VisionAssetOptions,
  DEFAULT_WASM_PATH,
  subjectStreamName,
} from "./base_vision";

const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

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
 * visibility) per landmark. The stream declares its stride and topology rather
 * than labelling every value; `pointChannelGroups` turns that into
 * "left wrist" and the indices of its components.
 *
 * Lugaresi, C. et al. (2019). MediaPipe: A Framework for Building Perception
 * Pipelines. arXiv:1906.08172. https://arxiv.org/abs/1906.08172
 */
export class PoseReceiver extends VisionReceiver {
  deviceName = "Pose Detection";
  deviceID: string | number;

  private landmarker: any;
  private options: Required<
    Pick<PoseOptions, "numPoses" | "includeVisibility" | "worldCoordinates">
  >;

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
  }

  private streamName(pose: number): string {
    return subjectStreamName("landmarks", "pose", pose, this.options.numPoses);
  }

  private registerStream(pose: number): void {
    this.ensureStream({
      modality: Modality.VIDEO,
      processingStage: ProcessingStage.INFERRED,
      name: this.streamName(pose),
      additionalMetadata: {
        samplingRate: this.assets.maxFps,
        ...pointStreamMetadata(
          POSE_LANDMARK_NAMES.length,
          this.components,
          MEDIAPIPE_POSE_33,
          this.options.worldCoordinates ? "world" : "image"
        ),
      },
    });
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

      this.update(
        {
          modality: Modality.VIDEO,
          processingStage: ProcessingStage.INFERRED,
          name: this.streamName(pose),
        },
        flattenPoints(points, components)
      );
    }
  }
}
