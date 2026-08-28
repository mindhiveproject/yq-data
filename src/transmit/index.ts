/**
 * The outbound half of the package: sending streams to somewhere else.
 *
 * {@link StreamTransmitter} is the mirror of `Recorder` — same input contract
 * (any `Observable<DataPacket>`), a transport instead of a zip. The transports
 * and the wire format live in `../transport`.
 */
export { StreamTransmitter } from "./stream_transmitter";
export type { StreamTransmitterOptions } from "./stream_transmitter";
