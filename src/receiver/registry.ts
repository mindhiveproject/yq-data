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
import { ParameterSchema, ParameterSpec } from "../analyzer/parameters";

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
const schemas = new Map<string, ParameterSchema>();

/**
 * Registers (or replaces) the implementation of a receiver type, with the
 * schema of the options it takes. A type registered without one takes its
 * options unchecked.
 */
export function registerReceiver(
  type: string,
  factory: ReceiverFactory,
  schema?: ParameterSchema
): void {
  registry.set(type, factory);
  if (schema) schemas.set(type, schema);
  else schemas.delete(type);
}

/**
 * The options a receiver type takes — type, default and range of each — the
 * receiving side's twin of `parameterSchema()`.
 *
 * It lists what can be stored as JSON. What only the app can supply (a
 * `videoElement`, EMOTIV's client credentials, a live `transport`) is left out.
 */
export function receiverSchema(type: string): ParameterSchema | undefined {
  return schemas.get(type);
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

/** Options every camera-derived receiver takes. */
const VISION: ParameterSchema = {
  maxFps: { type: "number", min: 1, max: 120, default: 30, unit: "fps" },
  delegate: { type: "enum", options: ["GPU", "CPU"], default: "GPU" },
  wasmPath: { type: "string" },
  modelAssetPath: { type: "string" },
};

/** `expects` as stored: metadata, or the name of a receiver type. */
const EXPECTS: ParameterSpec = {
  type: "json",
  description: "The streams the other end will send, or the receiver type that would produce them.",
};

const SCHEMAS: Record<string, ParameterSchema> = {
  muse: {
    model: { type: "enum", options: ["auto", "classic", "athena"], default: "auto" },
    enablePPG: { type: "boolean", default: true },
    enableAUX: { type: "boolean", default: false },
    preset: { type: "json", description: "Athena preset." },
  },
  emotiv: {
    socketURL: { type: "string", default: "wss://localhost:6868" },
    license: { type: "string" },
    debit: { type: "integer", min: 1 },
  },
  microphone: {
    framesPerPacket: { type: "integer", min: 128, default: 2048 },
    channelCount: { type: "integer", min: 1 },
    echoCancellation: { type: "boolean" },
    noiseSuppression: { type: "boolean" },
    autoGainControl: { type: "boolean" },
    deviceId: { type: "string" },
  },
  voice_emotion: {
    emitAffect: { type: "boolean" },
    affectHalfLife: { type: "number", min: 0, unit: "s" },
    pauseLength: { type: "number", min: 0 },
    minSegmentLength: { type: "number", min: 0 },
    modelPath: { type: "string" },
  },
  video: {
    deviceId: { type: "string" },
    facingMode: { type: "enum", options: ["user", "environment"], default: "user" },
    width: { type: "integer", min: 1 },
    height: { type: "integer", min: 1 },
    frameRate: { type: "number", min: 1 },
  },
  face_landmark: {
    ...VISION,
    numFaces: { type: "integer", min: 1, max: 4, default: 1 },
    emitLandmarks: { type: "boolean", default: false },
    emitHeadPose: { type: "boolean", default: true },
    emitFaceBox: { type: "boolean", default: false },
  },
  face_emotion: {
    ...VISION,
    maxFps: { ...VISION.maxFps, default: 15 },
    detector: { type: "enum", options: ["tiny", "ssd"], default: "tiny" },
    minConfidence: { type: "number", min: 0, max: 1, default: 0.5 },
    numFaces: { type: "integer", min: 1, max: 4, default: 1 },
    emitAgeGender: { type: "boolean", default: false },
    emitFaceBox: { type: "boolean", default: false },
    emitLandmarks: { type: "boolean", default: false },
    modelPath: { type: "string" },
  },
  pose: {
    ...VISION,
    numPoses: { type: "integer", min: 1, max: 4, default: 1 },
    includeVisibility: { type: "boolean", default: false },
    worldCoordinates: { type: "boolean", default: false },
  },
  rppg: {
    ...VISION,
    region: { type: "json", default: "both", description: "Skin region the colour is sampled from." },
    sampleSize: { type: "integer", min: 1, default: 160 },
    samplingRate: { type: "number", min: 1, unit: "Hz" },
    maxGap: { type: "number", min: 0, default: 0.25, unit: "s" },
  },
  lsl: {
    address: { type: "string", label: "Relay address" },
    autoReconnect: { type: "boolean", default: true },
    reconnectDelay: { type: "number", min: 0, unit: "ms" },
    maxReconnectDelay: { type: "number", min: 0, unit: "ms" },
    expects: EXPECTS,
  },
  marker: {
    deviceID: { type: "string", default: "markers" },
    name: { type: "string" },
    channelLabel: { type: "string", default: "marker" },
  },
  file_replay: {
    loop: { type: "boolean" },
    speed: { type: "number", min: 0 },
    tickInterval: { type: "number", min: 1, unit: "ms" },
  },
  arduino: {
    link: { type: "enum", options: ["serial", "bluetooth"], default: "serial" },
    linkOptions: { type: "json", description: "Options for the serial port or Bluetooth device request." },
    helloInterval: { type: "number", min: 0, default: 500, unit: "ms" },
    handshakeTimeout: { type: "number", min: 0, default: 5000, unit: "ms" },
    deviceID: { type: "string", default: "arduino" },
    expects: EXPECTS,
  },
  remote: {
    url: { type: "string", label: "Peer address" },
    deviceID: { type: "string", default: "remote" },
    trustRemoteClock: { type: "boolean" },
    closeTransportOnDisconnect: { type: "boolean", default: true },
    expects: EXPECTS,
  },
};

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

for (const [type, schema] of Object.entries(SCHEMAS)) schemas.set(type, schema);
