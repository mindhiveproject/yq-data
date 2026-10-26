/**
 * A `yq-arduino` board that lives in memory.
 *
 * This is the board's half of the conversation — answer `hello`, honour
 * `start`/`stop`, echo `ping`, accept `data` for its sinks, send `data` for its
 * sources — written against the same framing and MessagePack as the real thing.
 * It does two jobs:
 *
 * - **Tests.** {@link SimulatedArduino.port} is a {@link SerialPortLike}, so the
 *   whole receive path (`SerialTransport` → framing → `ArduinoProtocol` →
 *   `ArduinoReceiver`) runs under Jest with no hardware.
 * - **A readable reference** for what the Arduino library has to do, in the
 *   same language as the rest of the package.
 *
 * It can also stand in for a board in a demo page.
 *
 * ```ts
 * const board = new SimulatedArduino({
 *   id: "uno-1",
 *   streams: [{ name: "pot", format: "uint16", rate: 50, scale: 5 / 1024 }],
 * });
 * const arduino = new ArduinoReceiver(new SerialTransport(board.port));
 * await arduino.connect();
 * arduino.startStream();
 * board.emit("pot", [2.5]);
 * ```
 */
import { Modality } from "../data_stream.interface";
import {
  FrameDecoder,
  MAX_DECODED_FRAME,
  encodeFrame,
} from "./framing";
import { loadMsgpack, msgpackCodec } from "./msgpack";
import { SerialPortLike } from "./serial";
import {
  ARDUINO_MESSAGE,
  ARDUINO_PROTOCOL_VERSION,
  SAMPLE_FORMATS,
  SampleFormat,
} from "./arduino_protocol";

const FORMAT_CODES: Record<string, SampleFormat> = {
  int16: 0,
  uint16: 1,
  int8: 2,
  uint8: 3,
};

export interface SimulatedArduinoStream {
  name: string;
  /** A `Modality` value. Default `"unknown"`. */
  modality?: Modality | string;
  /** A sink receives from the app. Default: a source, which sends to it. */
  sink?: boolean;
  channels?: number;
  /** Hz. Omit for an irregular stream. */
  rate?: number;
  /** Default `"int16"`. */
  format?: "int16" | "uint16" | "int8" | "uint8";
  scale?: number;
  offset?: number;
  labels?: string[];
  unit?: string;
  /** Makes this a categorical stream. */
  categories?: string[];
}

export interface SimulatedArduinoOptions {
  streams: SimulatedArduinoStream[];
  /** Default `"sim-1"`. */
  id?: string;
  name?: string;
  firmware?: string;
  /** Default `"ms"`. */
  timeUnit?: "ms" | "us";
  /** Advertised `mf`. Default 254. */
  maxFrame?: number;
  /**
   * Milliseconds after the port opens during which input is thrown away and
   * state is reset — an Uno or ESP32 rebooting because DTR toggled.
   */
  bootDelay?: number;
  /** The board clock, in its time unit. Default: wall clock, wrapped to 32 bits. */
  clock?: () => number;
  /** Protocol version to announce. Default 1. For testing a mismatch. */
  protocolVersion?: number;
  /** Set `false` to make a board that never answers `hello`. */
  answerHello?: boolean;
}

/** One `data` message the board received for a sink. */
export interface SimulatedReceipt {
  stream: string;
  /** The app's `t`, as sent. */
  time: number;
  /** Physical values (`raw * scale + offset`), interleaved. */
  values: number[];
  raw: number[];
}

/* -------------------------------------------------------------------------- */
/* The port                                                                   */
/* -------------------------------------------------------------------------- */

type ReadResult = { value?: Uint8Array; done: boolean };

/**
 * An in-memory {@link SerialPortLike}. Bytes the app writes go to
 * `onWrite`; bytes pushed with {@link push} come out of the readable side.
 */
export class SimulatedSerialPort implements SerialPortLike {
  readable: SerialPortLike["readable"] = null;
  writable: SerialPortLike["writable"] = null;

  /** Receives every chunk the app writes. */
  onWrite: (bytes: Uint8Array) => void = () => {};
  /** Called when the port is opened. */
  onOpen: () => void = () => {};
  /** Called when the port is closed. */
  onClose: () => void = () => {};

  private chunks: Uint8Array[] = [];
  private waiting?: { resolve: (r: ReadResult) => void; reject: (e: unknown) => void };
  private listeners = new Set<() => void>();
  private ended = false;

  async open(): Promise<void> {
    if (this.readable) throw new Error("InvalidStateError: the port is already open.");
    this.chunks = [];
    this.ended = false;

    this.readable = {
      getReader: () => ({
        read: () => this.read(),
        cancel: async () => this.end(),
        releaseLock: () => {},
      }),
    };
    this.writable = {
      getWriter: () => ({
        write: async (chunk: Uint8Array) => this.onWrite(chunk),
        close: async () => {},
        releaseLock: () => {},
      }),
    };
    this.onOpen();
  }

  async close(): Promise<void> {
    this.end();
    this.readable = null;
    this.writable = null;
    this.onClose();
  }

  addEventListener(_type: "disconnect", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "disconnect", listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** Bytes from the board to the app. */
  push(bytes: Uint8Array): void {
    if (!this.readable || this.ended) return;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: bytes, done: false });
    } else {
      this.chunks.push(bytes);
    }
  }

  /** Pulls the cable: the pending read fails and `disconnect` fires. */
  unplug(): void {
    this.ended = true;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = undefined;
      reject(new Error("NetworkError: the device has been lost."));
    }
    this.listeners.forEach((listener) => listener());
  }

  private read(): Promise<ReadResult> {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  private end(): void {
    this.ended = true;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ done: true });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The board                                                                  */
/* -------------------------------------------------------------------------- */

interface ResolvedStream {
  index: number;
  config: SimulatedArduinoStream;
  channels: number;
  format: SampleFormat;
  scale: number;
  offset: number;
  sink: boolean;
}

export class SimulatedArduino {
  /** Hand this to `new SerialTransport(...)`. */
  readonly port = new SimulatedSerialPort();

  /** Whether the app has sent `start` and not `stop`. */
  streaming = false;
  /** Every decoded message the app has sent, in order. */
  readonly log: unknown[][] = [];
  /** Every `data` message received for a sink. */
  readonly received: SimulatedReceipt[] = [];

  private readonly options: SimulatedArduinoOptions;
  private readonly streams: ResolvedStream[];
  private readonly deframer: FrameDecoder;
  private bootTimer?: ReturnType<typeof setTimeout>;
  private booting = false;

  constructor(options: SimulatedArduinoOptions) {
    this.options = options;
    this.streams = options.streams.map((config, index) => ({
      index,
      config,
      channels: config.categories ? 1 : config.channels ?? 1,
      format: FORMAT_CODES[config.format ?? "int16"],
      scale: config.scale ?? 1,
      offset: config.offset ?? 0,
      sink: config.sink ?? false,
    }));

    this.deframer = new FrameDecoder(
      (body) => this.handleBody(body),
      MAX_DECODED_FRAME
    );

    this.port.onWrite = (bytes) => {
      if (this.booting) return;
      this.deframer.feed(bytes);
    };
    this.port.onOpen = () => this.onOpen();
    this.port.onClose = () => {
      clearTimeout(this.bootTimer);
      this.booting = false;
    };
  }

  /** Frame-level counters for what the board received. */
  get stats() {
    return this.deframer.stats;
  }

  /**
   * Sends `values` on a source stream: physical numbers, interleaved. Quantised
   * to the stream's format, split to fit a frame, and sent only while
   * streaming — as firmware would.
   */
  emit(name: string, values: ArrayLike<number>, time: number = this.clock()): void {
    const stream = this.source(name);
    const format = SAMPLE_FORMATS[stream.format];
    const raw = Array.from(values, (v) => {
      const r = Math.round((v - stream.offset) / stream.scale);
      return Number.isNaN(r) ? 0 : Math.min(format.max, Math.max(format.min, r));
    });
    this.emitRaw(name, raw, time);
  }

  /** Like {@link emit}, but with raw integers — for categorical streams. */
  emitRaw(name: string, raw: ArrayLike<number>, time: number = this.clock()): void {
    if (!this.streaming || this.booting) return;

    const stream = this.source(name);
    const format = SAMPLE_FORMATS[stream.format];
    const sampleBytes = stream.channels * format.bytes;
    const perMessage = Math.floor((MAX_DECODED_FRAME - 14) / sampleBytes);
    const samples = Math.floor(raw.length / stream.channels);

    for (let first = 0; first < samples; first += perMessage) {
      const count = Math.min(perMessage, samples - first);
      const bytes = new Uint8Array(count * sampleBytes);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < count * stream.channels; i++) {
        format.write(view, i * format.bytes, raw[first * stream.channels + i]);
      }
      this.send([ARDUINO_MESSAGE.DATA, stream.index, time >>> 0, bytes]);
    }
  }

  /** Bytes the board sends that are not a frame: line noise. */
  noise(bytes: Uint8Array): void {
    this.port.push(bytes);
  }

  /** Simulates the cable being pulled. */
  unplug(): void {
    this.port.unplug();
  }

  /** The board clock, in its time unit, wrapped to 32 bits. */
  clock = (): number => {
    if (this.options.clock) return this.options.clock();
    const ms = Date.now();
    return (this.options.timeUnit === "us" ? ms * 1000 : ms) % 2 ** 32;
  };

  /* ------------------------------- internals ------------------------------- */

  private source(name: string): ResolvedStream {
    const stream = this.streams.find((s) => s.config.name === name && !s.sink);
    if (!stream) throw new Error(`The simulated board has no source stream "${name}".`);
    return stream;
  }

  private onOpen(): void {
    this.streaming = false;
    this.deframer.reset();

    const delay = this.options.bootDelay ?? 0;
    if (delay <= 0) return;

    this.booting = true;
    this.bootTimer = setTimeout(() => {
      this.booting = false;
    }, delay);
  }

  private send(message: unknown[]): void {
    this.port.push(encodeFrame(msgpackCodec.encode(message) as Uint8Array));
  }

  private handleBody(body: Uint8Array): void {
    let message: unknown;
    try {
      message = msgpackCodec.decode(body);
    } catch {
      this.deframer.noteDecodeFailure();
      return;
    }
    if (!Array.isArray(message)) return;
    this.log.push(message);

    switch (message[0]) {
      case ARDUINO_MESSAGE.HELLO:
        this.streaming = false;
        if (this.options.answerHello !== false) this.describe();
        break;
      case ARDUINO_MESSAGE.START:
        this.streaming = true;
        break;
      case ARDUINO_MESSAGE.STOP:
        this.streaming = false;
        break;
      case ARDUINO_MESSAGE.PING:
        this.send([ARDUINO_MESSAGE.PONG, message[1], this.clock() >>> 0]);
        break;
      case ARDUINO_MESSAGE.DATA:
        this.receive(message);
        break;
    }
  }

  private describe(): void {
    this.send([
      ARDUINO_MESSAGE.BOARD,
      {
        v: this.options.protocolVersion ?? ARDUINO_PROTOCOL_VERSION,
        id: this.options.id ?? "sim-1",
        tu: this.options.timeUnit ?? "ms",
        mf: this.options.maxFrame ?? MAX_DECODED_FRAME,
        ns: this.streams.length,
        ...(this.options.name ? { name: this.options.name } : {}),
        ...(this.options.firmware ? { fw: this.options.firmware } : {}),
      },
    ]);

    for (const s of this.streams) {
      const c = s.config;
      this.send([
        ARDUINO_MESSAGE.STREAM,
        {
          i: s.index,
          n: c.name,
          m: c.modality ?? Modality.UNKNOWN,
          ...(s.sink ? { d: 1 } : {}),
          ...(s.channels !== 1 ? { c: s.channels } : {}),
          ...(c.rate ? { r: c.rate } : {}),
          ...(s.format !== 0 ? { f: s.format } : {}),
          ...(s.scale !== 1 ? { k: s.scale } : {}),
          ...(s.offset !== 0 ? { o: s.offset } : {}),
          ...(c.labels ? { l: c.labels } : {}),
          ...(c.unit ? { u: c.unit } : {}),
          ...(c.categories ? { q: c.categories } : {}),
        },
      ]);
    }
  }

  private receive(message: unknown[]): void {
    const [, index, time, payload] = message;
    const stream = this.streams.find((s) => s.index === index && s.sink);
    if (!stream || typeof time !== "number" || !(payload instanceof Uint8Array)) return;

    const format = SAMPLE_FORMATS[stream.format];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const raw: number[] = [];
    for (let i = 0; i + format.bytes <= payload.byteLength; i += format.bytes) {
      raw.push(format.read(view, i));
    }

    this.received.push({
      stream: stream.config.name,
      time,
      raw,
      values: raw.map((r) => r * stream.scale + stream.offset),
    });
  }

  /** Loads MessagePack. Called by the port's owner before the first byte moves. */
  static load(): Promise<void> {
    return loadMsgpack();
  }
}
