/**
 * Transports — bidirectional channels for moving streams between contexts.
 *
 * A {@link Transport} knows nothing about packets; it carries values. The
 * outbound half ({@link import("../transmit").StreamTransmitter}) and the
 * inbound half ({@link import("../receiver").RemoteStreamReceiver}) sit on top
 * of one and speak a {@link Protocol}: `yq-stream` by default, `yq-arduino`
 * with a board. See `protocol.ts` for how the layers are named.
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

// Protocols: what the messages on a transport mean.
export { identityFromStreamID } from "./protocol";
export type {
  Protocol,
  DecodeContext,
  Decoded,
  DecodedMeta,
  DecodedPacket,
  StreamIdentity,
} from "./protocol";

export {
  STREAM_PROTOCOL,
  STREAM_PROTOCOL_VERSION,
  streamProtocol,
  encodeStreamPacket,
  encodeStreamMeta,
  isStreamMessage,
  decodeStreamMessage,
} from "./stream_protocol";
export type {
  StreamMessage,
  StreamMetaMessage,
  StreamPacketMessage,
} from "./stream_protocol";

// An LSL relay, read as a protocol.
export { LSL_PROTOCOL, LSL_PROTOCOL_VERSION, LSLProtocol } from "./lsl_protocol";
export type { LSLStreamInfo } from "./lsl_protocol";

// Boards: yq-arduino over a serial port or BLE UART.
export {
  MAX_DECODED_FRAME,
  FRAME_DELIMITER,
  crc16,
  cobsEncode,
  cobsDecode,
  encodeFrame,
  FrameDecoder,
} from "./framing";
export type { FrameStats, FrameDropReason } from "./framing";
export { msgpackCodec, loadMsgpack } from "./msgpack";
export type { LoadableCodec } from "./msgpack";
export { ByteTransport } from "./byte_transport";
export type { ByteTransportOptions } from "./byte_transport";
export { SerialTransport } from "./serial";
export type {
  SerialPortLike,
  SerialLike,
  SerialTransportOptions,
  SerialRequestOptions,
} from "./serial";
export {
  ARDUINO_PROTOCOL,
  ARDUINO_PROTOCOL_VERSION,
  ARDUINO_MESSAGE,
  SAMPLE_FORMATS,
  ArduinoProtocol,
} from "./arduino_protocol";
export type {
  ArduinoBoard,
  ArduinoStream,
  ArduinoStats,
  SampleFormat,
  SampleFormatSpec,
  SinkRoute,
} from "./arduino_protocol";
export { SimulatedArduino, SimulatedSerialPort } from "./simulated_arduino";
export type {
  SimulatedArduinoOptions,
  SimulatedArduinoStream,
  SimulatedReceipt,
} from "./simulated_arduino";
