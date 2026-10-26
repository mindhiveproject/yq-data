/**
 * Byte-level framing for `yq-arduino`: COBS, CRC-16, and a stream deframer.
 *
 * A serial port or a BLE UART is a stream of bytes with no message boundaries,
 * so each message is wrapped as `COBS(body ‖ crc16) ‖ 0x00`. COBS guarantees
 * `0x00` never occurs inside a frame, so a receiver that loses its place —
 * noise, a half-sent frame, a board that reset mid-message — resynchronises at
 * the next delimiter. The CRC catches the rest.
 *
 * These are pure functions over bytes. `protocol/vectors.json` pins their
 * output, and the Arduino library is tested against the same file.
 */

/** Largest `body ‖ crc` a frame may carry, after COBS decoding. */
export const MAX_DECODED_FRAME = 254;

/** Frame delimiter. Never appears inside a COBS-encoded frame. */
export const FRAME_DELIMITER = 0x00;

/** Bytes of CRC appended to every body. */
export const CRC_BYTES = 2;

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF, no reflection, no final
 * XOR. `crc16("123456789") === 0x29b1`.
 */
export function crc16(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Consistent Overhead Byte Stuffing.
 *
 * Input that ends exactly on a full 254-byte block gets no empty block after
 * it. A naive encoder appends one, which turns a 254-byte payload into 256
 * bytes and breaks the protocol's "COBS adds exactly one byte" bound.
 */
export function cobsEncode(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length + Math.ceil(input.length / 254) + 1);
  let write = 1;
  let codeIndex = 0;
  let code = 1;
  let lastBlockFull = false;

  for (let i = 0; i < input.length; i++) {
    lastBlockFull = false;
    const byte = input[i];
    if (byte === 0) {
      out[codeIndex] = code;
      codeIndex = write++;
      code = 1;
    } else {
      out[write++] = byte;
      code++;
      if (code === 0xff) {
        out[codeIndex] = code;
        codeIndex = write++;
        code = 1;
        lastBlockFull = true;
      }
    }
  }

  if (lastBlockFull) {
    write--;
  } else {
    out[codeIndex] = code;
  }
  return out.subarray(0, write);
}

/**
 * Reverses {@link cobsEncode}. Returns `undefined` for malformed input — a
 * zero where a code byte should be, or a block that runs past the end.
 *
 * Accepts the trailing empty block a naive encoder would add, so frames from a
 * simpler implementation still decode. A code of `0xFF` means 254 data bytes
 * with no implied zero after them.
 */
export function cobsDecode(input: Uint8Array): Uint8Array | undefined {
  const out = new Uint8Array(input.length);
  let write = 0;
  let read = 0;

  while (read < input.length) {
    const code = input[read++];
    if (code === 0) return undefined;

    const end = read + code - 1;
    if (end > input.length) return undefined;

    for (; read < end; read++) {
      const byte = input[read];
      if (byte === 0) return undefined;
      out[write++] = byte;
    }

    if (code < 0xff && read < input.length) out[write++] = 0;
  }

  return out.subarray(0, write);
}

/**
 * Wraps a message body as one wire frame: `COBS(body ‖ crc16) ‖ 0x00`.
 *
 * Throws if `body ‖ crc` would exceed `maxDecoded` — a protocol ceiling of 254,
 * or less when the far end advertised a smaller buffer.
 */
export function encodeFrame(
  body: Uint8Array,
  maxDecoded: number = MAX_DECODED_FRAME
): Uint8Array {
  if (body.length + CRC_BYTES > maxDecoded) {
    throw new RangeError(
      `Frame body of ${body.length} bytes exceeds the ${maxDecoded - CRC_BYTES}-byte limit.`
    );
  }

  const crc = crc16(body);
  const payload = new Uint8Array(body.length + CRC_BYTES);
  payload.set(body);
  payload[body.length] = crc & 0xff;
  payload[body.length + 1] = crc >> 8;

  const encoded = cobsEncode(payload);
  const frame = new Uint8Array(encoded.length + 1);
  frame.set(encoded);
  frame[encoded.length] = FRAME_DELIMITER;
  return frame;
}

/** Why a frame was thrown away. */
export type FrameDropReason = "length" | "cobs" | "crc" | "decode";

export interface FrameStats {
  /** Bytes fed in. */
  bytes: number;
  /** Frames delivered. */
  frames: number;
  /** Non-empty frames discarded, by reason. Empty frames are not counted. */
  dropped: Record<FrameDropReason, number>;
}

/**
 * Cuts a byte stream into frames and checks each one.
 *
 * Feed it whatever chunks the pipe produces — a frame may be split across
 * several, or several may share one. Each valid frame's body (CRC stripped) is
 * handed to `onFrame`. Anything else is dropped and counted, never thrown: a
 * noisy link should lose frames, not crash the page.
 */
export class FrameDecoder {
  readonly stats: FrameStats = {
    bytes: 0,
    frames: 0,
    dropped: { length: 0, cobs: 0, crc: 0, decode: 0 },
  };

  private readonly buffer: Uint8Array;
  private length = 0;
  private overflowed = false;

  /**
   * @param onFrame - Receives each valid body.
   * @param maxDecoded - Largest `body ‖ crc` accepted. The raw buffer is two
   *   bytes larger, to hold the COBS byte and tolerate the naive trailing block.
   */
  constructor(
    private readonly onFrame: (body: Uint8Array) => void,
    private readonly maxDecoded: number = MAX_DECODED_FRAME
  ) {
    this.buffer = new Uint8Array(maxDecoded + 2);
  }

  /** Counts a frame whose body passed the frame layer but not the message layer. */
  noteDecodeFailure(): void {
    this.stats.dropped.decode++;
  }

  feed(chunk: Uint8Array): void {
    this.stats.bytes += chunk.length;

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];

      if (byte === FRAME_DELIMITER) {
        this.finishFrame();
        continue;
      }

      if (this.length >= this.buffer.length) {
        this.overflowed = true;
        continue;
      }
      this.buffer[this.length++] = byte;
    }
  }

  /** Forgets any half-received frame. */
  reset(): void {
    this.length = 0;
    this.overflowed = false;
  }

  private finishFrame(): void {
    const length = this.length;
    const overflowed = this.overflowed;
    this.reset();

    // Back-to-back delimiters are how either side flushes the other.
    if (length === 0 && !overflowed) return;

    if (overflowed) {
      this.stats.dropped.length++;
      return;
    }

    const decoded = cobsDecode(this.buffer.subarray(0, length));
    if (!decoded) {
      this.stats.dropped.cobs++;
      return;
    }

    if (decoded.length < CRC_BYTES + 1 || decoded.length > this.maxDecoded) {
      this.stats.dropped.length++;
      return;
    }

    const bodyLength = decoded.length - CRC_BYTES;
    const received = decoded[bodyLength] | (decoded[bodyLength + 1] << 8);
    if (crc16(decoded.subarray(0, bodyLength)) !== received) {
      this.stats.dropped.crc++;
      return;
    }

    this.stats.frames++;
    // Copy: the decoder reuses nothing, but a caller may hold the body.
    this.onFrame(decoded.slice(0, bodyLength));
  }
}
