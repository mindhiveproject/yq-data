/**
 * The `yq-data/1` wire format.
 *
 * A small, self-describing JSON envelope for carrying streams between contexts
 * — two tabs, a page and a worker, a browser and a server. It is deliberately
 * plain: an array of numbers rather than a binary frame, so a third party in
 * Python or Max can produce and consume it without a library.
 *
 * Two message types travel over a transport:
 *
 * - **`meta`** announces a stream. Sent before that stream's first `packet`,
 *   again whenever its metadata changes, and on a timer so a late subscriber
 *   on a fan-out transport can still learn the layout. Carries the full
 *   {@link StreamMetadata}.
 * - **`packet`** carries one chunk of samples. Interleaved, exactly as
 *   {@link DataPacket.data}, but as a plain `number[]`.
 *
 * A consumer that only ever sees `packet` messages (it connected late, the
 * producer never announces) can still reconstruct a usable stream: the packet
 * names its own `streamID` and `channelCount`, and a well-formed stream ID
 * carries the modality. A later `meta` upgrades that guess.
 */
import {
  DataPacket,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../data_stream.interface";
import { getChannelCount, isValidStreamID, stringToStreamID } from "../utility";

/** Protocol tag on every wire message. Bump the suffix on a breaking change. */
export const WIRE_PROTOCOL = "yq-data/1";

/** Announces a stream and its layout. */
export interface WireMetaMessage {
  protocol: typeof WIRE_PROTOCOL;
  type: "meta";
  streamID: string;
  metadata: StreamMetadata;
}

/** One chunk of interleaved samples on a stream. */
export interface WirePacketMessage {
  protocol: typeof WIRE_PROTOCOL;
  type: "packet";
  streamID: string;
  /** ms since epoch, the producer's host clock. */
  timestamp: number;
  /** The producer's device clock, when it kept one. */
  deviceTime?: number;
  /** Interleaved channel count, so a consumer can lay out `data` without `meta`. */
  channelCount: number;
  /** Interleaved samples: sample `i` of channel `c` at `data[i * channelCount + c]`. */
  data: number[];
  /** Categorical value per sample, for marker streams. */
  labels?: string[];
}

export type WireMessage = WireMetaMessage | WirePacketMessage;

/** Reduces a live packet to a `packet` wire message. */
export function packetToWire(packet: DataPacket): WirePacketMessage {
  const message: WirePacketMessage = {
    protocol: WIRE_PROTOCOL,
    type: "packet",
    streamID: packet.streamID,
    timestamp: packet.timestamp,
    channelCount: getChannelCount(packet),
    data: Array.from(packet.data),
  };
  if (packet.deviceTime !== undefined) message.deviceTime = packet.deviceTime;
  if (packet.labels !== undefined) message.labels = packet.labels;
  return message;
}

/** Wraps a stream's metadata in a `meta` wire message. */
export function metaToWire(metadata: StreamMetadata): WireMetaMessage {
  return {
    protocol: WIRE_PROTOCOL,
    type: "meta",
    streamID: metadata.streamID,
    metadata,
  };
}

/** Whether a value is a `yq-data/1` wire message. */
export function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === WIRE_PROTOCOL &&
    (record.type === "meta" || record.type === "packet") &&
    typeof record.streamID === "string"
  );
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
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

/** A decoder's account of one stream announcement. */
export interface DecodedMeta {
  kind: "meta";
  streamID: string;
  metadata: Partial<StreamMetadata>;
}

/** A decoder's account of one chunk of samples. */
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

/**
 * Turns a transport value into zero or more decoded stream updates.
 *
 * `RemoteStreamReceiver` takes one of these. The default reads the
 * `yq-data/1` envelope; a bridge to another protocol (an LSL relay's
 * `{ streamKey: { info, timeseries } }`, say) is just a different function of
 * the same shape.
 */
export type TransportDecoder = (value: unknown) => Decoded[];

/** Decoder for the `yq-data/1` wire format. */
export function wireDecoder(): TransportDecoder {
  return (value: unknown): Decoded[] => {
    if (!isWireMessage(value)) return [];

    if (value.type === "meta") {
      return [{ kind: "meta", streamID: value.streamID, metadata: value.metadata }];
    }

    return [
      {
        kind: "packet",
        streamID: value.streamID,
        data: Float32Array.from(value.data ?? []),
        timestamp: value.timestamp,
        deviceTime: value.deviceTime,
        labels: value.labels,
        metadata: { channelCount: value.channelCount },
      },
    ];
  };
}
