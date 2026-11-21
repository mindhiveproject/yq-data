import { BaseReceiver } from "./base_receiver";
import { MuseReceiver } from "./devices/muse";
import { EMOTIVReceiver } from "./devices/emotiv";
import { VideoReceiver } from "./devices/video";
import { MicrophoneReceiver } from "./devices/audio";
import { LSLReceiver } from "./devices/lsl";
import { FileReplayReceiver } from "./devices/file_replay";
import { ArduinoReceiver } from "./devices/arduino";
import { RemoteStreamReceiver } from "./devices/remote";
import { MarkerReceiver } from "./devices/marker";
import { FaceLandmarkReceiver } from "./devices/vision/face_landmarker";
import { PoseReceiver } from "./devices/vision/pose";
import { RPPGReceiver } from "./devices/vision/rppg";
import { FaceEmotionReceiver } from "./devices/vision/face_emotion";
import { VoiceEmotionReceiver } from "./devices/voice/voice_emotion";

/**
 * Constructs a receiver from one plain options object: the receiver's own
 * options, plus `videoElement` for a camera-derived receiver and `transport`
 * for one that reads a link.
 */
export type ReceiverFactory = (options: Record<string, any>) => BaseReceiver<any>;

/**
 * Maps a receiver type name to the class that implements it — the receiving
 * side's twin of the analyzer registry, so an application can say "muse" or
 * "face_landmark" where it stores what to connect, and a constructed but
 * unconnected receiver can announce its `expectedStreams()`.
 */
const registry = new Map<string, ReceiverFactory>();

/** Registers (or replaces) the implementation of a receiver type. */
export function registerReceiver(type: string, factory: ReceiverFactory): void {
  registry.set(type, factory);
}

/** Every receiver type currently registered. */
export function registeredReceivers(): string[] {
  return Array.from(registry.keys());
}

/**
 * Builds a receiver of a registered type. It is not connected.
 *
 * @throws when the type is not registered, listing the ones that are.
 */
export function createReceiver(
  type: string,
  options: Record<string, any> = {}
): BaseReceiver<any> {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(
      `No receiver registered for "${type}". Registered receivers: ${registeredReceivers().join(", ")}`
    );
  }
  return factory(options);
}

registerReceiver("muse", (o) => new MuseReceiver(o));
registerReceiver(
  "emotiv",
  ({ socketURL, ...user }) => new EMOTIVReceiver(user as any, socketURL)
);
registerReceiver("microphone", (o) => new MicrophoneReceiver(o));
registerReceiver("voice_emotion", (o) => new VoiceEmotionReceiver(o));
registerReceiver("video", ({ videoElement, ...o }) => new VideoReceiver(videoElement, o));
registerReceiver(
  "face_landmark",
  ({ videoElement, ...o }) => new FaceLandmarkReceiver(videoElement, o)
);
registerReceiver(
  "face_emotion",
  ({ videoElement, ...o }) => new FaceEmotionReceiver(videoElement, o)
);
registerReceiver("pose", ({ videoElement, ...o }) => new PoseReceiver(videoElement, o));
registerReceiver("rppg", ({ videoElement, ...o }) => new RPPGReceiver(videoElement, o));
registerReceiver("lsl", (o) => new LSLReceiver(o));
registerReceiver("marker", (o) => new MarkerReceiver(o));
registerReceiver("file_replay", (o) => new FileReplayReceiver(o));
registerReceiver("arduino", ({ transport, ...o }) => new ArduinoReceiver(transport, o));
registerReceiver("remote", ({ transport, ...o }) => new RemoteStreamReceiver(transport, o));
