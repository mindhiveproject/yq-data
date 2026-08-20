import { Modality, ProcessingStage } from "../../../data_stream.interface";
import {
  VisionReceiver,
  VisionAssetOptions,
  DEFAULT_WASM_PATH,
} from "./base_vision";

const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface FaceLandmarkOptions extends VisionAssetOptions {
  /** Faces to track. Each gets its own set of streams. */
  numFaces?: number;
  /** Emit the 478 landmark positions as well as the expression scores. */
  emitLandmarks?: boolean;
  /** Emit head yaw / pitch / roll derived from the transformation matrix. */
  emitHeadPose?: boolean;
}

/**
 * Facial expression tracking via MediaPipe Face Landmarker.
 *
 * Emits up to three streams per tracked face:
 * - `blendshapes` — 52 expression scores in 0–1, the primary signal and the
 *   one worth binding to a visual parameter.
 * - `head_pose` — yaw, pitch and roll in degrees.
 * - `landmarks` — 478 points as x, y, z triples. Off by default: 1434
 *   channels at frame rate is a lot of data for something most visuals never
 *   read.
 */
export class FaceLandmarkReceiver extends VisionReceiver {
  deviceName = "Face Landmarker";
  deviceID: string | number;

  private landmarker: any;
  private options: Required<
    Pick<FaceLandmarkOptions, "numFaces" | "emitLandmarks" | "emitHeadPose">
  >;
  private blendshapeNames: string[] = [];

  constructor(videoElement: HTMLVideoElement, options: FaceLandmarkOptions = {}) {
    super(videoElement, options);
    this.deviceID = "face-landmarker";
    this.options = {
      numFaces: 1,
      emitLandmarks: false,
      emitHeadPose: true,
      ...options,
    };
  }

  protected async createTask(vision: any): Promise<void> {
    const { FaceLandmarker, FilesetResolver } = vision;

    const resolver = await FilesetResolver.forVisionTasks(
      this.assets.wasmPath ?? DEFAULT_WASM_PATH
    );

    this.landmarker = await FaceLandmarker.createFromOptions(resolver, {
      baseOptions: {
        modelAssetPath: this.assets.modelAssetPath ?? DEFAULT_MODEL,
        delegate: this.assets.delegate,
      },
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: this.options.emitHeadPose,
      runningMode: "VIDEO",
      numFaces: this.options.numFaces,
    });

    // Blendshape names are only known once the model has produced a result,
    // so streams are registered lazily on the first frame.
  }

  protected closeTask(): void {
    this.landmarker?.close?.();
    this.landmarker = undefined;
    this.blendshapeNames = [];
  }

  private faceSuffix(face: number): string | undefined {
    return this.options.numFaces > 1 ? `face_${face + 1}` : undefined;
  }

  private registerStreams(face: number, names: string[]): void {
    const suffix = this.faceSuffix(face);
    const nameFor = (base: string) => (suffix ? `${base}_${suffix}` : base);

    this.initializeStream({
      modality: Modality.VIDEO,
      processingStage: ProcessingStage.INFERRED,
      name: nameFor("blendshapes"),
      additionalMetadata: {
        samplingRate: this.assets.maxFps,
        channelInfo: names.map((label, index) => ({ index, label })),
      },
    });

    if (this.options.emitHeadPose) {
      this.initializeStream({
        modality: Modality.VIDEO,
        processingStage: ProcessingStage.INFERRED,
        name: nameFor("head_pose"),
        additionalMetadata: {
          samplingRate: this.assets.maxFps,
          channelInfo: [
            { index: 0, label: "yaw", unit: "deg" },
            { index: 1, label: "pitch", unit: "deg" },
            { index: 2, label: "roll", unit: "deg" },
          ],
        },
      });
    }

    if (this.options.emitLandmarks) {
      this.initializeStream({
        modality: Modality.VIDEO,
        processingStage: ProcessingStage.INFERRED,
        name: nameFor("landmarks"),
        additionalMetadata: { samplingRate: this.assets.maxFps },
      });
    }
  }

  protected processFrame(timestampMs: number): void {
    if (!this.landmarker) return;

    const results = this.landmarker.detectForVideo(
      this.videoElement,
      timestampMs
    );
    const blendshapeSets = results?.faceBlendshapes ?? [];

    for (let face = 0; face < blendshapeSets.length; face++) {
      const categories = blendshapeSets[face]?.categories ?? [];
      if (categories.length === 0) continue;

      if (this.blendshapeNames.length === 0) {
        this.blendshapeNames = categories.map(
          (c: any) => c.displayName || c.categoryName
        );
        for (let f = 0; f < this.options.numFaces; f++) {
          this.registerStreams(f, this.blendshapeNames);
        }
      }

      const suffix = this.faceSuffix(face);
      const nameFor = (base: string) => (suffix ? `${base}_${suffix}` : base);

      this.update(
        {
          modality: Modality.VIDEO,
          processingStage: ProcessingStage.INFERRED,
          name: nameFor("blendshapes"),
        },
        categories.map((c: any) => c.score)
      );

      if (this.options.emitHeadPose) {
        const matrix = results?.facialTransformationMatrixes?.[face]?.data;
        if (matrix) {
          this.update(
            {
              modality: Modality.VIDEO,
              processingStage: ProcessingStage.INFERRED,
              name: nameFor("head_pose"),
            },
            eulerFromMatrix(matrix)
          );
        }
      }

      if (this.options.emitLandmarks) {
        const points = results?.faceLandmarks?.[face];
        if (points) {
          const flat = new Float32Array(points.length * 3);
          for (let i = 0; i < points.length; i++) {
            flat[i * 3] = points[i].x;
            flat[i * 3 + 1] = points[i].y;
            flat[i * 3 + 2] = points[i].z;
          }
          this.update(
            {
              modality: Modality.VIDEO,
              processingStage: ProcessingStage.INFERRED,
              name: nameFor("landmarks"),
            },
            flat
          );
        }
      }
    }
  }
}

/**
 * Extracts yaw, pitch and roll in degrees from a column-major 4×4 transform.
 *
 * Uses the standard Y-X-Z decomposition; gimbal lock near ±90° pitch is not
 * handled, which is acceptable because a face that far from the camera is no
 * longer being tracked reliably anyway.
 */
function eulerFromMatrix(m: ArrayLike<number>): [number, number, number] {
  const r = (row: number, col: number) => m[col * 4 + row];
  const toDegrees = 180 / Math.PI;

  const pitch = Math.asin(-Math.max(-1, Math.min(1, r(2, 1))));
  const yaw = Math.atan2(r(2, 0), r(2, 2));
  const roll = Math.atan2(r(0, 1), r(1, 1));

  return [yaw * toDegrees, pitch * toDegrees, roll * toDegrees];
}
