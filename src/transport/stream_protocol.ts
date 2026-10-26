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
 * Every message carries a protocol tag. The tag this protocol was first
 * published under was `"yq-data/1"`, and other platforms speak it; it is still
 * what this package **sends** by default, and `"yq-stream"` with `v: 1` is read
 * alongside it. Flip the default with {@link createStreamProtocol} once those
 * platforms accept the new tag. The two carry identical fields.
 *
 * A consumer that only ever sees `packet` messages (it connected late, the
 * producer never announces) can still reconstruct a usable stream: the packet
 * names its own `streamID` and `channelCount`, and a well-formed stream ID
 * carries the modality. A later `meta` upgrades that guess.
 */
import { DataPacket, StreamMetadata } from "../data_stream.interface";
import { getChannelCount } from "../utility";
import { Decoded, Protocol } from "./protocol";

/** The protocol's name. On the wire it is `protocol`, with the version in `v`. */
export const STREAM_PROTOCOL = "yq-stream";
/** Protocol version, as `v`. Bumped on a breaking change. */
export const STREAM_PROTOCOL_VERSION = 1;

/**
 * The tag the protocol first shipped under: name and version in one string, no
 * `v`. Always read; sent unless told otherwise.
 */
export const LEGACY_STREAM_TAG = "yq-data/1";

/** Which tag a producer writes. */
export type StreamTag = "legacy" | "current";

/** Announces a stream and its layout. */
export interface StreamMetaMessage {
  protocol: typeof STREAM_PROTOCOL | typeof LEGACY_STREAM_TAG;
  /** Absent on a message tagged `"yq-data/1"`, whose tag already says it. */
  v?: number;
  type: "meta";
  streamID: string;
  metadata: StreamMetadata;
}

/** One chunk of interleaved samples on a stream. */
export interface StreamPacketMessage {
  protocol: typeof STREAM_PROTOCOL | typeof LEGACY_STREAM_TAG;
  /** Absent on a message tagged `"yq-data/1"`, whose tag already says it. */
  v?: number;
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

/** The `protocol` / `v` fields for a tag. A legacy message has no `v`. */
function tagFields(
  tag: StreamTag
): Pick<StreamMetaMessage, "protocol" | "v"> {
  return tag === "legacy"
    ? { protocol: LEGACY_STREAM_TAG }
    : { protocol: STREAM_PROTOCOL, v: STREAM_PROTOCOL_VERSION };
}

/** Reduces a live packet to a `packet` message. */
export function encodeStreamPacket(
  packet: DataPacket,
  tag: StreamTag = "legacy"
): StreamPacketMessage {
  const message: StreamPacketMessage = {
    ...tagFields(tag),
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
export function encodeStreamMeta(
  metadata: StreamMetadata,
  tag: StreamTag = "legacy"
): StreamMetaMessage {
  return {
    ...tagFields(tag),
    type: "meta",
    streamID: metadata.streamID,
    metadata,
  };
}

/**
 * Whether a value is a `yq-stream` message this package can read: tagged
 * `"yq-data/1"`, or `"yq-stream"` with `v: 1`. A message from another version
 * is not: its fields may mean something else.
 */
export function isStreamMessage(value: unknown): value is StreamMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const tagged =
    record.protocol === LEGACY_STREAM_TAG ||
    (record.protocol === STREAM_PROTOCOL && record.v === STREAM_PROTOCOL_VERSION);
  return (
    tagged &&
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

/**
 * `yq-stream` as a {@link Protocol}, writing the given tag. Both tags are read
 * whatever this says.
 */
export function createStreamProtocol(options: { emit?: StreamTag } = {}): Protocol {
  const tag = options.emit ?? "legacy";
  return {
    name: STREAM_PROTOCOL,
    version: STREAM_PROTOCOL_VERSION,
    decode: decodeStreamMessage,
    encodePacket: (packet) => [encodeStreamPacket(packet, tag)],
    encodeMeta: (metadata) => encodeStreamMeta(metadata, tag),
  };
}

/** The default on any transport nothing has claimed. Writes the legacy tag. */
export const streamProtocol: Protocol = createStreamProtocol();

/* -------------------------------------------------------------------------- */
/* Names this protocol had before it was called yq-stream                     */
/* -------------------------------------------------------------------------- */

/** @deprecated Use {@link LEGACY_STREAM_TAG}. */
export const WIRE_PROTOCOL = LEGACY_STREAM_TAG;
/** @deprecated Use {@link StreamMessage}. */
export type WireMessage = StreamMessage;
/** @deprecated Use {@link StreamMetaMessage}. */
export type WireMetaMessage = StreamMetaMessage;
/** @deprecated Use {@link StreamPacketMessage}. */
export type WirePacketMessage = StreamPacketMessage;
/** @deprecated Use {@link Protocol}. */
export type TransportDecoder = (value: unknown) => Decoded[];
/** @deprecated Use {@link encodeStreamPacket}. */
export const packetToWire = (packet: DataPacket): StreamPacketMessage =>
  encodeStreamPacket(packet);
/** @deprecated Use {@link encodeStreamMeta}. */
export const metaToWire = (metadata: StreamMetadata): StreamMetaMessage =>
  encodeStreamMeta(metadata);
/** @deprecated Use {@link isStreamMessage}. */
export const isWireMessage = isStreamMessage;
/** @deprecated Use {@link streamProtocol}`.decode`. */
export const wireDecoder = (): TransportDecoder => decodeStreamMessage;
