import { BaseTransport, WireCodec } from "./transport";
import { LoadableCodec, msgpackCodec } from "./msgpack";
import {
  FRAME_DELIMITER,
  FrameDecoder,
  FrameStats,
  MAX_DECODED_FRAME,
  encodeFrame,
} from "./framing";

export interface ByteTransportOptions {
  /**
   * Value <-> body codec. Defaults to MessagePack. A codec with a `load()`
   * method is awaited by `ready()` before any traffic moves.
   */
  codec?: WireCodec | LoadableCodec;
  /** Largest `body ‖ crc` this link carries. Default and ceiling: 254. */
  maxFrame?: number;
}

function isLoadable(codec: WireCodec): codec is LoadableCodec {
  return typeof (codec as LoadableCodec).load === "function";
}

function toBytes(encoded: ReturnType<WireCodec["encode"]>): Uint8Array {
  if (typeof encoded === "string") return new TextEncoder().encode(encoded);
  if (encoded instanceof Uint8Array) return encoded;
  if (ArrayBuffer.isView(encoded)) {
    return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  }
  return new Uint8Array(encoded as ArrayBufferLike);
}

/**
 * A transport over a raw byte pipe — a serial port, a BLE UART.
 *
 * Unlike a WebSocket, the pipe has no message boundaries, so this owns the
 * framing: outgoing values go through the codec, get a CRC and COBS, and leave
 * as one delimited frame; incoming bytes are cut into frames, checked, decoded
 * and delivered to listeners as plain values. A concrete transport supplies
 * only `write()`, and calls `feed()` with whatever arrives.
 *
 * `structuredClone` is `false`: the far end — usually a microcontroller — has
 * its own clock.
 */
export abstract class ByteTransport extends BaseTransport {
  readonly structuredClone = false;

  protected readonly codec: WireCodec | LoadableCodec;
  private readonly maxFrame: number;
  private readonly deframer: FrameDecoder;
  private oversize = 0;

  constructor(options: ByteTransportOptions = {}) {
    super();
    this.codec = options.codec ?? msgpackCodec;
    this.maxFrame = Math.min(options.maxFrame ?? MAX_DECODED_FRAME, MAX_DECODED_FRAME);
    this.deframer = new FrameDecoder((body) => this.deliver(body), this.maxFrame);
  }

  /** Bytes, frames and drops since this transport was created. */
  get stats(): FrameStats & { oversize: number } {
    return { ...this.deframer.stats, oversize: this.oversize };
  }

  /** Writes raw bytes to the pipe, in order. */
  protected abstract write(bytes: Uint8Array): void | Promise<void>;

  /** Loads the codec. Subclasses await this before opening the pipe. */
  protected async prepare(): Promise<void> {
    if (isLoadable(this.codec)) await this.codec.load();
  }

  /**
   * Marks the link open and flushes it with a lone delimiter, so whatever
   * half-frame the far end was holding is discarded instead of glued to ours.
   */
  protected markOpen(): void {
    this.deframer.reset();
    this.setOpen(true);
    void this.write(Uint8Array.of(FRAME_DELIMITER));
  }

  /** Hands bytes from the pipe to the deframer. */
  protected feed(bytes: Uint8Array): void {
    this.deframer.feed(bytes);
  }

  send(value: unknown): void {
    if (!this.isOpen) return;

    let frame: Uint8Array;
    try {
      frame = encodeFrame(toBytes(this.codec.encode(value)), this.maxFrame);
    } catch (error) {
      // An unencodable or oversize message is the caller's bug, but it must not
      // take down the stream that triggered it.
      this.oversize++;
      console.warn(`${this.kind} transport: dropping an unsendable message.`, error);
      return;
    }
    void this.write(frame);
  }

  private deliver(body: Uint8Array): void {
    let value: unknown;
    try {
      value = this.codec.decode(body);
    } catch {
      this.deframer.noteDecodeFailure();
      return;
    }
    this.emit(value);
  }
}
