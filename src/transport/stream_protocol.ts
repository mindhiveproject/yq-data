/**
 * The `yq-stream` protocol.
 *
 * What two yq-data peers say to each other: a small, self-describing envelope
 * for carrying streams between contexts — two tabs, a page and a worker, a
 * browser and a server. It is deliberately plain: an array of numbers rather
 * than a binary frame, so a third party in Python or Max can produce and
 * consume it over a JSON WebSocket without a library. The protocol does not
 * depend on JSON, though; a binary codec on the transport carries the same
 * messages.
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
 * Every message carries `protocol: "yq-stream"` and `v: 1`. Messages tagged
 * `"yq-data/1"`, the name this protocol was first published under, are not
 * read: see `docs/migration.md`.
 *
 * A consumer that only ever sees `packet` messages (it connected late, the
 * producer never announces) can still reconstruct a usable stream: the packet
 * names its own `streamID` and `channelCount`, and a well-formed stream ID
 * carries the modality. A later `meta` upgrades that guess.
 */
import { DataPacket, StreamMetadata } from "../data_stream.interface";
import { getChannelCount } from "../utility";
import { Decoded, Protocol } from "./protocol";

/** The protocol's name, on the wire as `protocol`. */
export const STREAM_PROTOCOL = "yq-stream";
/** Protocol version, on the wire as `v`. Bumped on a breaking change. */
export const STREAM_PROTOCOL_VERSION = 1;

/** Announces a stream and its layout. */
export interface StreamMetaMessage {
  protocol: typeof STREAM_PROTOCOL;
  v: typeof STREAM_PROTOCOL_VERSION;
  type: "meta";
  streamID: string;
  metadata: StreamMetadata;
}

/** One chunk of interleaved samples on a stream. */
export interface StreamPacketMessage {
  protocol: typeof STREAM_PROTOCOL;
  v: typeof STREAM_PROTOCOL_VERSION;
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

export type StreamMessage = StreamMetaMessage | StreamPacketMessage;

/** Reduces a live packet to a `packet` message. */
export function encodeStreamPacket(packet: DataPacket): StreamPacketMessage {
  const message: StreamPacketMessage = {
    protocol: STREAM_PROTOCOL,
    v: STREAM_PROTOCOL_VERSION,
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

/** Wraps a stream's metadata in a `meta` message. */
export function encodeStreamMeta(metadata: StreamMetadata): StreamMetaMessage {
  return {
    protocol: STREAM_PROTOCOL,
    v: STREAM_PROTOCOL_VERSION,
    type: "meta",
    streamID: metadata.streamID,
    metadata,
  };
}

/**
 * Whether a value is a `yq-stream` message this package can read: tagged
 * `"yq-stream"` with `v: 1`. A message from another version is not — its fields
 * may mean something else.
 */
export function isStreamMessage(value: unknown): value is StreamMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === STREAM_PROTOCOL &&
    record.v === STREAM_PROTOCOL_VERSION &&
    (record.type === "meta" || record.type === "packet") &&
    typeof record.streamID === "string"
  );
}

/** Decodes one `yq-stream` message. Anything else decodes to nothing. */
export function decodeStreamMessage(value: unknown): Decoded[] {
  if (!isStreamMessage(value)) return [];

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
}

/** `yq-stream` as a {@link Protocol}: the default on any transport nothing has claimed. */
export const streamProtocol: Protocol = {
  name: STREAM_PROTOCOL,
  version: STREAM_PROTOCOL_VERSION,
  decode: decodeStreamMessage,
  encodePacket: (packet) => [encodeStreamPacket(packet)],
  encodeMeta: encodeStreamMeta,
};
