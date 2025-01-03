import { Modality } from "../../data-stream.interface";
import { BaseReceiver, EventCallbacks } from "../base_receiver";


export class VideoReceiver extends BaseReceiver {
    deviceName = 'Video';
    modalities = [Modality.Video];
    baseConfig = {
        [Modality.Video]: {
            samplingRate: 30,
            channelNames: ['video_stream']
        }
    }
    stream: MediaStream | undefined = undefined;
    videoElement: HTMLVideoElement;

    constructor(videoElement: HTMLVideoElement, frameRate = 30) {
        super();
        this.setSamplingRate(Modality.Video, frameRate)
        this.videoElement = videoElement;
    }

    async connect(callbacks?: EventCallbacks): Promise<void> {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                },
                audio: false,
            });
            this.videoElement.srcObject = this.stream;
            callbacks?.onSuccess?.();
            this.isConnected = true;
        } catch (e) {
            this.isConnected = false;
            callbacks?.onError?.(e as Error);
        }
    }

    async startStream() {
        if (!this.isConnected) return;
        if (this.videoElement.paused) {
            this.videoElement.play();
        } else {
            this.videoElement.addEventListener("loadedmetadata", () => {
                this.videoElement.play();
            });
        }
    }

    async stopStream() {
        this.videoElement.pause()
        this.isConnected = false;
    }

    async disconnect() {
        this.isConnected = false;
        this.videoElement.pause();
        this.videoElement.removeAttribute('src'); // empty source
        this.videoElement.load();
    }

} 