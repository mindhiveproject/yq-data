/**
 * Transports — bidirectional channels for moving streams between contexts.
 *
 * A {@link Transport} knows nothing about packets; it carries values. The
 * outbound half ({@link import("../transmit").StreamTransmitter}) and the
 * inbound half ({@link import("../receiver").RemoteStreamReceiver}) sit on top
 * of one and speak the `yq-data/1` wire format defined in `wire.ts`.
 */
export { BaseTransport, jsonCodec } from "./transport";
export type { Transport, TransportKind, WireCodec } from "./transport";

export { MemoryTransport } from "./memory";
export { BroadcastChannelTransport } from "./broadcast_channel";
export type { BroadcastChannelLike } from "./broadcast_channel";
export { PostMessageTransport } from "./post_message";
export type {
  PostMessageOptions,
  PostMessageTarget,
  PostMessageSource,
} from "./post_message";
export { WebSocketTransport } from "./websocket";
export type {
  WebSocketLike,
  WebSocketTransportOptions,
} from "./websocket";

export {
  WIRE_PROTOCOL,
  packetToWire,
  metaToWire,
  isWireMessage,
  wireDecoder,
  identityFromStreamID,
} from "./wire";
export type {
  WireMessage,
  WireMetaMessage,
  WirePacketMessage,
  Decoded,
  DecodedMeta,
  DecodedPacket,
  TransportDecoder,
  StreamIdentity,
} from "./wire";
