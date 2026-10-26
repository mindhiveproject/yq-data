/**
 * Protocols — what the messages on a transport mean.
 *
 * Moving streams between places has three layers, and each is named on its own
 * axis so the names never compete:
 *
 * - A **transport** is how values move: `WebSocketTransport`,
 *   `SerialTransport`, `PostMessageTransport`. Named by mechanism.
 * - A **codec** is how a value becomes bytes, for the transports that need
 *   bytes: `jsonCodec`, `msgpackCodec`. Named by format.
 * - A **protocol** is what the messages say. Named by who is on the other end:
 *   `yq-stream` between two yq-data peers, `yq-arduino` with a board, `lsl`
 *   with an LSL relay (decode-only, since nothing is sent back).
 *
 * Any protocol can run over any transport that suits it — yq-stream over a
 * WebSocket or a serial cable, yq-arduino over serial, Bluetooth or an ESP32's
 * Wi-Fi — which is the test a new name has to pass.
 *
 * A transport carries the protocol spoken on it in `transport.protocol`.
 * `StreamTransmitter` and `RemoteStreamReceiver` read it from there, and fall
 * back to yq-stream when nothing has claimed the link. An `ArduinoReceiver`
 * claims its transport, which is what lets a pipeline `transmit` node reach a
 * board with nothing but a transport key in the graph.
 */
import {
  DataPacket,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../data_stream.interface";
import { isValidStreamID, stringToStreamID } from "../utility";

export interface Protocol {
  /** `"yq-stream"`, `"yq-arduino"`, or a bridge's own name. */
  readonly name: string;
  /** Bumped on a breaking change, and carried on the wire as an integer. */
  readonly version: number;

  /**
   * Turns one incoming transport value into zero or more stream updates.
   *
   * A stateful decoder can use `context.streaming` to avoid spending state on
   * samples the receiver is about to drop — an LSL marker stream assigns a
   * numeric code the first time it sees a label, and should not do so for a
   * label nobody receives.
   */
  decode(value: unknown, context?: DecodeContext): Decoded[];

  /**
   * Turns one packet into the messages that carry it. An empty array skips
   * the packet — a board, say, accepting only the streams it has sinks for.
   */
  encodePacket(packet: DataPacket): unknown[];

  /**
   * Announces a stream's metadata. A protocol without this has no such
   * message, and a transmitter speaking it never announces.
   */
  encodeMeta?(metadata: StreamMetadata): unknown;
}

/* -------------------------------------------------------------------------- */
/* What decoding takes and produces                                           */
/* -------------------------------------------------------------------------- */

/** What the receiver knows that a decoder might want to. */
export interface DecodeContext {
  /**
   * Whether the receiver will deliver samples. Stream announcements are
   * always delivered; `startStream()` is what turns samples on.
   */
  streaming: boolean;
}

/** A protocol's account of one stream announcement. */
export interface DecodedMeta {
  kind: "meta";
  streamID: string;
  metadata: Partial<StreamMetadata>;
}

/** A protocol's account of one chunk of samples. */
export interface DecodedPacket {
  kind: "packet";
  streamID: string;
  data: number | ArrayLike<number> | ArrayLike<number>[];
  timestamp?: number;
  deviceTime?: number;
  labels?: string[];
  /** Best-effort metadata, used only if the stream has not been announced. */
  metadata?: Partial<StreamMetadata>;
}

export type Decoded = DecodedMeta | DecodedPacket;

/* -------------------------------------------------------------------------- */
/* Stream identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The stream-identity fields, pulled from a stream ID.
 *
 * A well-formed `deviceID:modality:stage[:name]` ID decomposes exactly; an ID
 * in any other shape becomes the `name` of an `unknown` stream on this
 * receiver's own device, which still round-trips as a stable identifier even
 * though it loses the original text.
 */
export interface StreamIdentity {
  deviceID: string;
  modality: Modality;
  processingStage: ProcessingStage;
  name?: string;
}

/** Splits a stream ID into identity fields, falling back for odd shapes. */
export function identityFromStreamID(
  streamID: string,
  fallbackDeviceID: string
): StreamIdentity {
  if (isValidStreamID(streamID)) {
    const parsed = stringToStreamID(streamID);
    return {
      deviceID: String(parsed.deviceID),
      modality: parsed.modality,
      processingStage: parsed.processingStage,
      name: parsed.name,
    };
  }
  return {
    deviceID: fallbackDeviceID,
    modality: Modality.UNKNOWN,
    processingStage: ProcessingStage.RAW,
    name: streamID.replace(/:/g, "_"),
  };
}
