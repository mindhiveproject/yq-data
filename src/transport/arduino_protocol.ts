/**
 * The `yq-arduino` protocol — what a board says over a serial port, a BLE UART
 * or any other byte link, and how it becomes yq-data streams.
 *
 * Framing lives in `framing.ts` and the MessagePack codec in `msgpack.ts`; this
 * is what the decoded values mean. The spec is `docs/arduino-protocol.md`, and
 * `protocol/vectors.json` pins the bytes.
 *
 * {@link ArduinoProtocol} is stateful, because a `data` message only makes
 * sense against the descriptors announced before it: a stream index means
 * nothing until its `stream` message has been seen. So unlike yq-stream, each
 * board gets its own instance.
 */
import {
  ChannelInfo,
  DataPacket,
  Modality,
  ProcessingStage,
  StreamMetadata,
} from "../data_stream.interface";
import { genericChannelInfo, isModality } from "../utility";
import { CRC_BYTES, MAX_DECODED_FRAME } from "./framing";
import { Decoded, Protocol } from "./protocol";

export const ARDUINO_PROTOCOL = "yq-arduino";
/** Carried on the wire as `v`, in `hello` and in the `board` message. */
export const ARDUINO_PROTOCOL_VERSION = 1;

/** Message types. Direction is implied by the type. */
export const ARDUINO_MESSAGE = {
  BOARD: 1,
  STREAM: 2,
  DATA: 3,
  HELLO: 4,
  START: 5,
  STOP: 6,
  PING: 7,
  PONG: 8,
} as const;

/** Smallest `mf` a board may advertise, so a descriptor always fits. */
export const MIN_MAX_FRAME = 64;

/**
 * Bytes a `data` message may spend besides its payload: array header, type, a
 * two-byte index, a five-byte time and a two-byte `bin` header come to 11, and
 * one is kept spare. With the 2-byte CRC that leaves `mf - 14` for samples —
 * 240 bytes at the protocol ceiling.
 */
const DATA_OVERHEAD = 12;

/* -------------------------------------------------------------------------- */
/* Sample formats                                                             */
/* -------------------------------------------------------------------------- */

/** Wire code for a sample format: `f` in a `stream` message. */
export type SampleFormat = 0 | 1 | 2 | 3;

export interface SampleFormatSpec {
  name: "int16" | "uint16" | "int8" | "uint8";
  bytes: number;
  min: number;
  max: number;
  read(view: DataView, offset: number): number;
  write(view: DataView, offset: number, value: number): void;
}

/** All multi-byte samples are little-endian. */
export const SAMPLE_FORMATS: Record<SampleFormat, SampleFormatSpec> = {
  0: {
    name: "int16",
    bytes: 2,
    min: -32768,
    max: 32767,
    read: (view, offset) => view.getInt16(offset, true),
    write: (view, offset, value) => view.setInt16(offset, value, true),
  },
  1: {
    name: "uint16",
    bytes: 2,
    min: 0,
    max: 65535,
    read: (view, offset) => view.getUint16(offset, true),
    write: (view, offset, value) => view.setUint16(offset, value, true),
  },
  2: {
    name: "int8",
    bytes: 1,
    min: -128,
    max: 127,
    read: (view, offset) => view.getInt8(offset),
    write: (view, offset, value) => view.setInt8(offset, value),
  },
  3: {
    name: "uint8",
    bytes: 1,
    min: 0,
    max: 255,
    read: (view, offset) => view.getUint8(offset),
    write: (view, offset, value) => view.setUint8(offset, value),
  },
};

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                */
/* -------------------------------------------------------------------------- */

/** What a `board` message says about the board. */
export interface ArduinoBoard {
  version: number;
  /** Becomes `deviceID` in stream IDs. */
  id: string;
  /** Unit of every `t` this board sends. */
  timeUnit: "ms" | "us";
  /** Largest frame the board accepts, after COBS decoding and including CRC. */
  maxFrame: number;
  /** How many `stream` messages follow. */
  streamCount: number;
  name?: string;
  firmware?: string;
}

/** What a `stream` message says about one stream. */
export interface ArduinoStream {
  index: number;
  name: string;
  modality: Modality;
  /** A source sends to the app; a sink receives from it. */
  direction: "source" | "sink";
  channels: number;
  /** Hz. Absent for an irregular stream, which sends one sample per message. */
  rate?: number;
  format: SampleFormat;
  scale: number;
  offset: number;
  labels?: string[];
  unit?: string;
  /** Present for a categorical stream: raw values index into this. */
  categories?: string[];
  /** The stream ID this source publishes under. Unset for a sink. */
  streamID: string;
}

/* -------------------------------------------------------------------------- */
/* Protocol                                                                   */
/* -------------------------------------------------------------------------- */

interface TimeState {
  last?: number;
  unwrapped: number;
}

/**
 * Where a packet goes: a sink's name, or `undefined` to skip it. A record maps
 * stream IDs to sink names.
 */
export type SinkRoute =
  | Record<string, string>
  | ((packet: DataPacket) => string | undefined);

/** Counters for messages the protocol set aside. */
export interface ArduinoStats {
  /** `data` for a stream never announced, or one that is a sink. */
  unknownStream: number;
  /** `data` whose payload did not fit its stream's layout. */
  badPayload: number;
  /** Messages that were not the shape any message type has. */
  malformed: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUint = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * One conversation with one board, as a {@link Protocol}.
 *
 * `decode` turns the board's messages into the `Decoded` updates
 * `RemoteStreamReceiver` understands; `encodePacket` turns packets into `data`
 * messages for the board's sinks, routed by {@link route}; {@link hello},
 * {@link start}, {@link sinkMessages} and the rest build the control messages.
 * It never touches a transport — sending is the caller's job — which keeps it
 * testable with nothing but arrays.
 */
export class ArduinoProtocol implements Protocol {
  readonly name = ARDUINO_PROTOCOL;
  readonly version = ARDUINO_PROTOCOL_VERSION;

  /** What the board said about itself, once it has. */
  board?: ArduinoBoard;
  readonly streams = new Map<number, ArduinoStream>();
  readonly stats: ArduinoStats = { unknownStream: 0, badPayload: 0, malformed: 0 };

  /**
   * Which sink each outgoing packet goes to. By default, the sink named like
   * the packet's stream, so a stream called `led` reaches a sink called `led`.
   */
  route?: SinkRoute;

  /** Set when a `board` message announces a protocol version we do not speak. */
  incompatible?: number;

  /** Called with the version when a `board` message announces one we do not speak. */
  onIncompatible?: (version: number) => void;
  /** Called when a `board` message has been accepted. */
  onBoard?: (board: ArduinoBoard) => void;
  /** Called once the `board` message and all its `stream` messages are in. */
  onReady?: (board: ArduinoBoard) => void;
  /** Called with the echoed sequence number and the board clock, in ms. */
  onPong?: (seq: number, deviceTimeMs: number) => void;

  private announced = 0;
  private readonly time = new Map<number, TimeState>();

  /** Whether the board has described itself completely. */
  get ready(): boolean {
    return this.board !== undefined && this.announced >= this.board.streamCount;
  }

  /** Streams that send to the app. */
  get sources(): ArduinoStream[] {
    return Array.from(this.streams.values()).filter((s) => s.direction === "source");
  }

  /** Streams that receive from the app. */
  get sinks(): ArduinoStream[] {
    return Array.from(this.streams.values()).filter((s) => s.direction === "sink");
  }

  /** Largest frame the board can receive, after COBS decoding. */
  get maxFrame(): number {
    return this.board?.maxFrame ?? MAX_DECODED_FRAME;
  }

  /** Forgets everything announced. A new `board` message does this itself. */
  reset(): void {
    this.board = undefined;
    this.incompatible = undefined;
    this.streams.clear();
    this.time.clear();
    this.announced = 0;
  }

  /** The sink called `name`, if the board has one. */
  sink(name: string): ArduinoStream | undefined {
    return this.sinks.find((s) => s.name === name);
  }

  /* ------------------------------ app -> board ------------------------------ */

  hello(): unknown[] {
    return [ARDUINO_MESSAGE.HELLO, ARDUINO_PROTOCOL_VERSION];
  }

  start(): unknown[] {
    return [ARDUINO_MESSAGE.START];
  }

  stop(): unknown[] {
    return [ARDUINO_MESSAGE.STOP];
  }

  ping(seq: number): unknown[] {
    return [ARDUINO_MESSAGE.PING, seq];
  }

  /**
   * The `data` messages that carry `values` to a sink, split so each fits the
   * board's receive buffer.
   *
   * Values are physical and interleaved; each is quantised with
   * `round((v - offset) / scale)` and clamped to the sink's format. A trailing
   * partial sample is ignored. Returns an empty array for an unknown sink.
   */
  sinkMessages(
    name: string,
    values: ArrayLike<number>,
    hostTime: number = Date.now()
  ): unknown[][] {
    const stream = this.sink(name);
    if (!stream) return [];

    const format = SAMPLE_FORMATS[stream.format];
    const sampleBytes = stream.channels * format.bytes;
    const room = this.maxFrame - CRC_BYTES - DATA_OVERHEAD;
    const perMessage = Math.floor(room / sampleBytes);
    if (perMessage < 1) {
      console.warn(
        `Sink "${name}" needs ${sampleBytes} bytes per sample, more than the board accepts.`
      );
      return [];
    }

    const samples = Math.floor(values.length / stream.channels);
    const time = Math.floor(hostTime) % 2 ** 32;
    const messages: unknown[][] = [];

    for (let first = 0; first < samples; first += perMessage) {
      const count = Math.min(perMessage, samples - first);
      const bytes = new Uint8Array(count * sampleBytes);
      const view = new DataView(bytes.buffer);

      for (let i = 0; i < count * stream.channels; i++) {
        const value = values[first * stream.channels + i];
        const raw = Math.round((value - stream.offset) / stream.scale);
        const clamped = Number.isNaN(raw)
          ? 0
          : Math.min(format.max, Math.max(format.min, raw));
        format.write(view, i * format.bytes, clamped);
      }

      messages.push([ARDUINO_MESSAGE.DATA, stream.index, time, bytes]);
    }

    return messages;
  }

  /**
   * The `data` messages for one packet, sent to the sink {@link route} picks.
   * Empty — the packet is skipped — when it routes nowhere, or to a sink the
   * board does not have.
   */
  readonly encodePacket = (packet: DataPacket): unknown[] => {
    const sink = this.sinkFor(packet);
    return sink ? this.sinkMessages(sink, packet.data) : [];
  };

  private sinkFor(packet: DataPacket): string | undefined {
    const route = this.route;
    if (typeof route === "function") return route(packet);
    if (route) return route[packet.streamID];
    return packet.metadata.name ?? packet.streamID.split(":")[3];
  }

  /* ------------------------------ board -> app ------------------------------ */

  /** Bound, so it can be handed around on its own. */
  readonly decode = (value: unknown): Decoded[] => this.handle(value);

  private handle(value: unknown): Decoded[] {
    if (!Array.isArray(value) || !isUint(value[0])) {
      this.stats.malformed++;
      return [];
    }

    switch (value[0]) {
      case ARDUINO_MESSAGE.BOARD:
        return this.handleBoard(value[1]);
      case ARDUINO_MESSAGE.STREAM:
        return this.handleStream(value[1]);
      case ARDUINO_MESSAGE.DATA:
        return this.handleData(value);
      case ARDUINO_MESSAGE.PONG:
        this.handlePong(value);
        return [];
      default:
        // Types we do not know are ignored, so v1 can grow.
        return [];
    }
  }

  private handleBoard(body: unknown): Decoded[] {
    if (!isRecord(body) || typeof body.id !== "string" || !body.id) {
      this.stats.malformed++;
      return [];
    }

    this.reset();

    if (body.v !== ARDUINO_PROTOCOL_VERSION) {
      this.incompatible = typeof body.v === "number" ? body.v : -1;
      this.onIncompatible?.(this.incompatible);
      return [];
    }

    const unit = body.tu === "us" ? "us" : "ms";
    const maxFrame = isUint(body.mf, MAX_DECODED_FRAME)
      ? Math.max(body.mf, MIN_MAX_FRAME)
      : MAX_DECODED_FRAME;

    this.board = {
      version: body.v,
      id: body.id.replace(/:/g, "_"),
      timeUnit: unit,
      maxFrame,
      streamCount: isUint(body.ns) ? body.ns : 0,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.fw === "string" ? { firmware: body.fw } : {}),
    };

    this.onBoard?.(this.board);
    if (this.ready) this.onReady?.(this.board);
    return [];
  }

  private handleStream(body: unknown): Decoded[] {
    if (!this.board) return [];
    if (!isRecord(body) || !isUint(body.i, 255) || typeof body.n !== "string" || !body.n) {
      this.stats.malformed++;
      return [];
    }

    const format: SampleFormat =
      body.f === 1 || body.f === 2 || body.f === 3 ? body.f : 0;
    const categories =
      Array.isArray(body.q) && body.q.every((q) => typeof q === "string")
        ? (body.q as string[])
        : undefined;
    const modality =
      typeof body.m === "string" && isModality(body.m) ? body.m : Modality.UNKNOWN;
    const name = body.n.replace(/:/g, "_");

    const stream: ArduinoStream = {
      index: body.i,
      name,
      modality,
      direction: body.d === 1 ? "sink" : "source",
      // A categorical stream is one channel of labels, however it was declared.
      channels: categories ? 1 : isUint(body.c) && body.c > 0 ? body.c : 1,
      ...(!categories && isNumber(body.r) && body.r > 0 ? { rate: body.r } : {}),
      format,
      scale: isNumber(body.k) && body.k !== 0 ? body.k : 1,
      offset: isNumber(body.o) ? body.o : 0,
      ...(Array.isArray(body.l) ? { labels: body.l.map(String) } : {}),
      ...(typeof body.u === "string" ? { unit: body.u } : {}),
      ...(categories ? { categories } : {}),
      streamID: `${this.board.id}:${modality}:${ProcessingStage.RAW}:${name}`,
    };

    const replacing = this.streams.has(stream.index);
    this.streams.set(stream.index, stream);
    this.time.delete(stream.index);
    if (!replacing) this.announced++;
    if (this.ready) this.onReady?.(this.board);

    // A sink is something we write to; it publishes nothing.
    if (stream.direction === "sink") return [];

    return [
      { kind: "meta", streamID: stream.streamID, metadata: this.metadataFor(stream) },
    ];
  }

  private metadataFor(stream: ArduinoStream): Partial<StreamMetadata> {
    const channelInfo: ChannelInfo[] = (
      stream.channels === 1
        ? [{ index: 0, label: stream.name }]
        : genericChannelInfo(stream.channels, stream.name)
    ).map((channel, index) => ({
      ...channel,
      ...(stream.labels?.[index] ? { label: stream.labels[index] } : {}),
      ...(stream.unit ? { unit: stream.unit } : {}),
    }));

    return {
      modality: stream.modality,
      channelCount: stream.channels,
      channelInfo,
      // An irregular or categorical stream declares no rate: the absence is what
      // keeps rate-dependent nodes off it.
      ...(stream.rate !== undefined ? { samplingRate: stream.rate } : {}),
      ...(stream.categories ? { valueType: "categorical" as const } : {}),
      additionalMetadata: {
        arduino: {
          index: stream.index,
          format: SAMPLE_FORMATS[stream.format].name,
          scale: stream.scale,
          offset: stream.offset,
          ...(stream.categories ? { categories: stream.categories } : {}),
          ...(this.board?.name ? { board: this.board.name } : {}),
          ...(this.board?.firmware ? { firmware: this.board.firmware } : {}),
        },
      },
    };
  }

  private handleData(message: unknown[]): Decoded[] {
    const [, index, rawTime, payload] = message;

    if (!isUint(index) || !isUint(rawTime, 2 ** 32 - 1) || !ArrayBuffer.isView(payload)) {
      this.stats.malformed++;
      return [];
    }

    const stream = this.streams.get(index);
    if (!stream || stream.direction !== "source" || !this.board) {
      this.stats.unknownStream++;
      return [];
    }

    const format = SAMPLE_FORMATS[stream.format];
    const sampleBytes = stream.channels * format.bytes;
    if (payload.byteLength === 0 || payload.byteLength % sampleBytes !== 0) {
      this.stats.badPayload++;
      return [];
    }

    // `bin` payloads arrive as a view at an arbitrary byte offset, so they are
    // read through a DataView; an Int16Array over them could throw on alignment.
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = payload.byteLength / format.bytes;
    const data = new Float32Array(count);
    const labels: string[] | undefined = stream.categories ? [] : undefined;

    for (let i = 0; i < count; i++) {
      const raw = format.read(view, i * format.bytes);
      if (stream.categories) {
        // Codes start at 1, matching MarkerReceiver and LSLReceiver.
        data[i] = raw + 1;
        labels!.push(stream.categories[raw] ?? String(raw));
      } else {
        data[i] = raw * stream.scale + stream.offset;
      }
    }

    return [
      {
        kind: "packet",
        streamID: stream.streamID,
        data,
        deviceTime: this.deviceTime(stream.index, rawTime, this.board.timeUnit),
        ...(labels ? { labels } : {}),
        metadata: { channelCount: stream.channels },
      },
    ];
  }

  /**
   * The board's clock in milliseconds, unwrapped across 32-bit rollover.
   *
   * `t` wraps every 49 days at ms and 71 minutes at µs. The signed difference
   * from the previous `t` on the same stream is exact as long as the gap
   * between two messages is under half the range.
   */
  private deviceTime(index: number, raw: number, unit: "ms" | "us"): number {
    let state = this.time.get(index);
    if (!state) {
      state = { unwrapped: raw };
    } else if (state.last !== undefined) {
      state.unwrapped += (raw - state.last) | 0;
    }
    state.last = raw;
    this.time.set(index, state);
    return unit === "us" ? state.unwrapped / 1000 : state.unwrapped;
  }

  private handlePong(message: unknown[]): void {
    const [, seq, rawTime] = message;
    if (!isUint(seq) || !isUint(rawTime, 2 ** 32 - 1) || !this.board) {
      this.stats.malformed++;
      return;
    }
    this.onPong?.(seq, this.board.timeUnit === "us" ? rawTime / 1000 : rawTime);
  }
}
