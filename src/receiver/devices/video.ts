import { Modality } from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";

export interface VideoReceiverOptions {
  /** `deviceId` of a specific camera, from {@link VideoReceiver.listCameras}. */
  deviceId?: string;
  /** Which way the camera faces when no specific device is requested. */
  facingMode?: "user" | "environment";
  width?: number;
  height?: number;
  frameRate?: number;
}

/**
 * Camera lifecycle handle.
 *
 * Deliberately emits no packets. Pushing raw frames through the packet layer
 * would mean copying a megabyte per frame through RxJS for consumers that all
 * want the *same* `HTMLVideoElement` anyway — so this receiver owns the
 * camera and the element, and the vision receivers (face landmarker, pose,
 * rPPG) read pixels from that element directly. One camera can therefore feed
 * several analyses at no extra cost.
 *
 * The element must stay mounted for the duration: unmounting it tears down
 * playback and every derived stream stops.
 */
export class VideoReceiver extends BaseReceiver {
  deviceName: string = "Video";
  modalities: Modality[] = [Modality.VIDEO];
  deviceID: string | number;
  readonly emitsPackets = false;

  videoElement: HTMLVideoElement;
  videoStream: MediaStream | undefined;

  private options: VideoReceiverOptions;

  constructor(
    videoElement: HTMLVideoElement,
    options: VideoReceiverOptions | number = {}
  ) {
    super();

    // A bare number used to mean frameRate in the original signature.
    this.options =
      typeof options === "number" ? { frameRate: options } : options;

    this.videoElement = videoElement;
    this.deviceID = videoElement.id || "camera";
  }

  /**
   * Cameras available to the page.
   *
   * Labels are empty until the user has granted camera permission at least
   * once, so call this after a first `connect()` if you need a named picker.
   */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  }

  /** Resolution and frame rate actually granted, once connected. */
  get settings(): MediaTrackSettings | undefined {
    return this.videoStream?.getVideoTracks()[0]?.getSettings();
  }

  async connect(options?: VideoReceiverOptions): Promise<void> {
    if (options) this.options = { ...this.options, ...options };
    const { deviceId, facingMode = "user", width, height, frameRate } =
      this.options;

    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode }),
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
          ...(frameRate ? { frameRate } : {}),
        },
        audio: false,
      });

      this.videoElement.srcObject = this.videoStream;
      // Autoplay policies reject a camera preview that is neither muted nor
      // user-initiated, and inline playback is required on iOS.
      this.videoElement.muted = true;
      this.videoElement.playsInline = true;

      if (deviceId) this.deviceID = deviceId;

      this.isConnected = true;
    } catch (e) {
      console.error("Failed to connect video stream:", e);
      this.isConnected = false;
      throw e;
    }
  }

  /** Resolves once the element reports usable dimensions. */
  async ready(): Promise<void> {
    if (this.videoElement.readyState >= 2) return;
    await new Promise<void>((resolve) => {
      this.videoElement.addEventListener("loadeddata", () => resolve(), {
        once: true,
      });
    });
  }

  async startStream(): Promise<void> {
    if (!this.isConnected) return;
    await this.videoElement.play();
    await this.ready();
  }

  async stopStream(): Promise<void> {
    this.videoElement.pause();
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.videoElement.pause();

    // Releasing the tracks is what actually turns the camera light off;
    // clearing srcObject alone leaves the device claimed.
    this.videoStream?.getTracks().forEach((track) => track.stop());
    this.videoStream = undefined;
    this.videoElement.srcObject = null;
  }
}
