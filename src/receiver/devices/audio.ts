import { Modality, ProcessingStage } from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";

const AUDIO_CHANNEL_NAMES: Record<number, string[]> = {
  1: ["mono"],
  2: ["left", "right"],
  4: ["left", "right", "surround left", "surround right"],
  6: [
    "left",
    "right",
    "center",
    "subwoofer",
    "surround left",
    "surround right",
  ],
};

function channelNamesFor(count: number): string[] {
  return (
    AUDIO_CHANNEL_NAMES[count] ??
    Array.from({ length: count }, (_, i) => `channel ${i + 1}`)
  );
}

const PROCESSOR_NAME = "yq-raw-audio";

/**
 * Worklet processor source.
 *
 * This runs in the AudioWorkletGlobalScope, a separate JavaScript realm on the
 * audio thread — it cannot close over anything from this module, which is why
 * it is a source string registered through a Blob URL rather than a class
 * imported normally. Its only channel back to the main thread is `port`.
 *
 * It batches the 128-frame render quanta the audio thread delivers into larger
 * packets before posting: at 48 kHz a quantum is 2.7 ms, so forwarding each
 * one would mean ~375 messages a second per microphone.
 */
const PROCESSOR_SOURCE = `
class YQRawAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const params = (options && options.processorOptions) || {};
    this.framesPerPacket = params.framesPerPacket || 2048;
    this.channelCount = params.channelCount || 1;
    this.buffer = new Float32Array(this.framesPerPacket * this.channelCount);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = Math.min(input.length, this.channelCount);
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        this.buffer[this.offset + c] = input[c][i];
      }
      this.offset += this.channelCount;

      if (this.offset >= this.buffer.length) {
        // Transfer the buffer rather than copying it across the thread
        // boundary, then allocate a fresh one for the next packet.
        const packet = this.buffer;
        this.buffer = new Float32Array(this.framesPerPacket * this.channelCount);
        this.offset = 0;
        this.port.postMessage(packet, [packet.buffer]);
      }
    }

    return true;
  }
}

registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, YQRawAudioProcessor);
`;

export interface MicrophoneOptions {
  /** Frames per channel in each emitted packet. Sets the packet rate. */
  framesPerPacket?: number;
  /** Force a channel count; defaults to whatever the input device provides. */
  channelCount?: number;
  /** Browser audio processing. Off by default so measurements stay faithful. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** `deviceId` of a specific microphone. */
  deviceId?: string;
}

/**
 * Microphone receiver, streaming raw audio samples.
 *
 * Emits interleaved PCM at the AudioContext's sample rate. Loudness, spectral
 * features and anything else derived belong in a {@link Pipeline} — an
 * {@link RMSAnalyzer} after a {@link Windowing} node reproduces the original
 * dBFS volume device.
 *
 * Browser audio processing (echo cancellation, noise suppression, AGC) is
 * disabled by default: all three are designed to make speech intelligible on a
 * call, and all three distort the amplitude relationships a measurement
 * depends on.
 */
export class MicrophoneReceiver extends BaseReceiver {
  deviceName: string = "Microphone";
  modalities: Modality[] = [Modality.AUDIO];
  deviceID: string | number;

  audioStream: MediaStream | undefined;
  audioContext: AudioContext | undefined;

  private source: MediaStreamAudioSourceNode | undefined;
  private worklet: AudioWorkletNode | undefined;
  private moduleURL: string | undefined;
  private options: MicrophoneOptions;
  private streaming = false;

  constructor(options: MicrophoneOptions = {}) {
    super();
    this.options = { framesPerPacket: 2048, ...options };
    this.deviceID = options.deviceId ?? "microphone";
  }

  /** Microphones available to the page. */
  static async listMicrophones(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  }

  async connect(): Promise<void> {
    const {
      deviceId,
      echoCancellation = false,
      noiseSuppression = false,
      autoGainControl = false,
    } = this.options;

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation,
          noiseSuppression,
          autoGainControl,
        },
      });

      this.audioContext = new AudioContext();

      if (!this.audioContext.audioWorklet) {
        throw new Error(
          "AudioWorklet is unavailable in this browser; the microphone receiver requires it."
        );
      }

      // The worklet module has to be fetched by URL, so the processor source
      // is published as a Blob URL rather than shipped as a separate file —
      // that keeps yq-data a single importable package with no asset copying
      // step in the consuming app's build.
      const blob = new Blob([PROCESSOR_SOURCE], {
        type: "application/javascript",
      });
      this.moduleURL = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(this.moduleURL);

      this.source = this.audioContext.createMediaStreamSource(this.audioStream);

      const track = this.audioStream.getAudioTracks()[0];
      const channelCount =
        this.options.channelCount ??
        track?.getSettings().channelCount ??
        this.source.channelCount ??
        1;

      const channelNames = channelNamesFor(channelCount);

      this.worklet = new AudioWorkletNode(this.audioContext, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount,
        // Without "explicit" the node ignores channelCount and takes whatever
        // the source provides, which would silently disagree with the channel
        // count the processor and the stream metadata were built around.
        channelCountMode: "explicit",
        processorOptions: {
          framesPerPacket: this.options.framesPerPacket,
          channelCount,
        },
      });

      this.ensureStream({
        modality: Modality.AUDIO,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: this.audioContext.sampleRate,
          channelInfo: channelNames.map((label, index) => ({ index, label })),
          bufferSize: this.options.framesPerPacket,
        },
      });

      this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.streaming) return;
        this.update({ modality: Modality.AUDIO }, event.data);
      };

      this.source.connect(this.worklet);
      // The worklet has no outputs and is never connected to the destination,
      // so nothing is routed back to the speakers and there is no feedback.

      this.isConnected = true;
    } catch (e) {
      console.error("Failed to connect audio stream:", e);
      this.isConnected = false;
      await this.disconnect();
      throw e;
    }
  }

  async startStream(): Promise<void> {
    if (!this.audioContext) return;
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    this.streaming = true;
  }

  async stopStream(): Promise<void> {
    this.streaming = false;
    if (this.audioContext?.state === "running") {
      await this.audioContext.suspend();
    }
  }

  async disconnect(): Promise<void> {
    this.streaming = false;
    this.isConnected = false;

    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = undefined;
    }

    this.source?.disconnect();
    this.source = undefined;

    this.audioStream?.getTracks().forEach((track) => track.stop());
    this.audioStream = undefined;

    if (this.moduleURL) {
      URL.revokeObjectURL(this.moduleURL);
      this.moduleURL = undefined;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }
    this.audioContext = undefined;
  }
}
