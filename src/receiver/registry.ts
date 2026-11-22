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
import { StreamMetadata } from "../data_stream.interface";
import { WebSocketTransport } from "../transport/websocket";
import { SerialTransport } from "../transport/serial";
import { BluetoothTransport } from "../transport/bluetooth";

/**
 * Constructs a receiver from one plain options object: the receiver's own
 * options, plus `videoElement` for a camera-derived receiver. A receiver that
 * reads a link takes a live `transport`, or plain options that say how to
 * open one on `connect()`, so it can be built from stored JSON:
 *
 * - `lsl`: `{ address }`, the relay's WebSocket URL.
 * - `remote`: `{ url }`, a yq-stream peer's WebSocket URL.
 * - `arduino`: `{ link: "serial" | "bluetooth", linkOptions? }`; the port or
 *   device is asked for when `connect()` is called, so call it from a click.
 *   `linkOptions` go to `SerialTransport.request()` (e.g. `baudRate`) or
 *   `BluetoothTransport.request()` (e.g. `filters`).
 *
 * Those three also take `expects`: the streams the other end will send, or
 * the name of a registered receiver whose streams they are (`"muse"` for a
 * relay forwarding a Muse), reported until the real ones are announced.
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
/** `expects` as stored: metadata, or the receiver type that would produce it. */
function expectedStreams(expects: unknown): StreamMetadata[] | undefined {
  if (typeof expects !== "string") return expects as StreamMetadata[] | undefined;
  return createReceiver(expects).expectedStreams();
}

registerReceiver(
  "lsl",
  ({ expects, ...o }) => new LSLReceiver({ ...o, expects: expectedStreams(expects) })
);
registerReceiver("marker", (o) => new MarkerReceiver(o));
registerReceiver("file_replay", (o) => new FileReplayReceiver(o));
registerReceiver("arduino", ({ transport, link, linkOptions, expects, ...o }) => {
  const open =
    transport ??
    (link === "bluetooth"
      ? () => BluetoothTransport.request(linkOptions)
      : link === "serial" || link === undefined
        ? () => SerialTransport.request(linkOptions)
        : undefined);
  if (!open) {
    throw new Error(`Unknown Arduino link "${link}"; use "serial" or "bluetooth".`);
  }
  return new ArduinoReceiver(open, { ...o, expects: expectedStreams(expects) });
});
registerReceiver("remote", ({ transport, url, expects, ...o }) => {
  if (!transport && !url) {
    throw new Error('A "remote" receiver needs a `url` (or a `transport`).');
  }
  return new RemoteStreamReceiver(transport ?? (() => new WebSocketTransport(url)), {
    ...o,
    expects: expectedStreams(expects),
  });
});
