import { ByteTransport, ByteTransportOptions } from "./byte_transport";

/** The slice of a Web Serial reader this transport drives. */
interface SerialReaderLike {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** The slice of a Web Serial writer this transport drives. */
interface SerialWriterLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
}

/** The slice of a Web Serial `SerialPort` this transport drives. */
export interface SerialPortLike {
  open(options: { baudRate: number } & Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  readable: { getReader(): SerialReaderLike } | null;
  writable: { getWriter(): SerialWriterLike } | null;
  addEventListener?(type: "disconnect", listener: () => void): void;
  removeEventListener?(type: "disconnect", listener: () => void): void;
}

/** The slice of `navigator.serial` used to find a port. */
export interface SerialLike {
  requestPort(options?: {
    filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
  }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

export interface SerialTransportOptions extends ByteTransportOptions {
  /** Default 115200. Must match the board's `Serial.begin()`. */
  baudRate?: number;
  /** Further `SerialPort.open()` options: `dataBits`, `parity`, `flowControl`… */
  portOptions?: Record<string, unknown>;
}

export interface SerialRequestOptions extends SerialTransportOptions {
  /** Restrict the port picker to these USB IDs. */
  filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
  /** Defaults to `navigator.serial`. */
  serial?: SerialLike;
}

function resolveSerial(serial?: SerialLike): SerialLike {
  const found =
    serial ?? (globalThis as { navigator?: { serial?: SerialLike } }).navigator?.serial;
  if (!found) {
    throw new Error(
      "Web Serial is not available here. Use a Chromium browser over HTTPS or localhost."
    );
  }
  return found;
}

/**
 * A transport over a Web Serial port, speaking `yq-arduino` framing.
 *
 * ```ts
 * const transport = await SerialTransport.request({ baudRate: 115200 });
 * const board = new ArduinoReceiver(transport);
 * await board.connect();
 * ```
 *
 * `request()` shows the browser's port picker, which needs a user gesture —
 * call it from a click handler. A port the user has granted before can be
 * reopened without one through `granted()`.
 *
 * There is no auto-reconnect, unlike `WebSocketTransport`: a reopened port
 * restarts the board (Uno and most ESP32 dev boards reset when DTR toggles),
 * so a reconnect is a new session, and `ArduinoReceiver.connect()` is the thing
 * that runs one.
 */
export class SerialTransport extends ByteTransport {
  readonly kind = "serial" as const;

  private readonly port: SerialPortLike;
  private readonly baudRate: number;
  private readonly portOptions: Record<string, unknown>;

  private reader?: SerialReaderLike;
  private writer?: SerialWriterLike;
  private opening?: Promise<void>;
  private closedByUs = false;
  private writeChain: Promise<void> = Promise.resolve();
  private teardown?: Promise<void>;
  private readonly onDisconnect = () => this.setOpen(false);

  constructor(port: SerialPortLike, options: SerialTransportOptions = {}) {
    super(options);
    this.port = port;
    this.baudRate = options.baudRate ?? 115200;
    this.portOptions = options.portOptions ?? {};
  }

  /** Asks the user to pick a port. Needs a user gesture. */
  static async request(options: SerialRequestOptions = {}): Promise<SerialTransport> {
    const serial = resolveSerial(options.serial);
    const port = await serial.requestPort(
      options.filters ? { filters: options.filters } : undefined
    );
    return new SerialTransport(port, options);
  }

  /**
   * Reuses a port the user already granted, or `undefined` if there is none.
   * Needs no gesture. With several granted ports, picks the first; pass
   * `choose` to decide.
   */
  static async granted(
    options: SerialRequestOptions & {
      choose?: (ports: SerialPortLike[]) => SerialPortLike | undefined;
    } = {}
  ): Promise<SerialTransport | undefined> {
    const ports = await resolveSerial(options.serial).getPorts();
    const port = options.choose ? options.choose(ports) : ports[0];
    return port ? new SerialTransport(port, options) : undefined;
  }

  /** Opens the port. Resolves when frames can flow; rejects if it cannot open. */
  ready(): Promise<void> {
    if (this.closedByUs) {
      return Promise.reject(new Error("Transport has been closed."));
    }
    this.opening ??= this.open();
    return this.opening;
  }

  /** Resolves once a `close()` has finished releasing the port. */
  get closed(): Promise<void> {
    return this.teardown ?? Promise.resolve();
  }

  close(): void {
    if (this.closedByUs) return;
    this.closedByUs = true;
    this.setOpen(false);
    this.teardown = this.release();
  }

  protected write(bytes: Uint8Array): Promise<void> {
    // Writes are queued so frames reach the port in the order they were sent.
    this.writeChain = this.writeChain
      .then(() => this.writer?.write(bytes))
      .catch((error) => {
        console.warn("SerialTransport: write failed.", error);
      });
    return this.writeChain;
  }

  private async open(): Promise<void> {
    try {
      await this.prepare();

      // Opening a port that is already open throws, and a granted port may be.
      if (!this.port.readable) {
        await this.port.open({ baudRate: this.baudRate, ...this.portOptions });
      }
      if (!this.port.readable || !this.port.writable) {
        throw new Error("Serial port opened without a readable and writable stream.");
      }

      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.port.addEventListener?.("disconnect", this.onDisconnect);
    } catch (error) {
      this.opening = undefined;
      throw error;
    }

    this.markOpen();
    void this.readLoop(this.reader);
  }

  private async readLoop(reader: SerialReaderLike): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.feed(value);
      }
    } catch {
      // The cable was pulled, or the port was closed under us. Either way the
      // link is gone; the open state below is how the receiver finds out.
    } finally {
      if (!this.closedByUs) this.setOpen(false);
    }
  }

  private async release(): Promise<void> {
    this.port.removeEventListener?.("disconnect", this.onDisconnect);

    // Let queued writes finish first, so a final `stop` message is not lost.
    await this.writeChain;

    const reader = this.reader;
    const writer = this.writer;
    this.reader = undefined;
    this.writer = undefined;

    try {
      await reader?.cancel();
    } catch {
      /* already closed */
    }
    try {
      reader?.releaseLock();
    } catch {
      /* already released */
    }
    try {
      await writer?.close();
    } catch {
      /* already closed */
    }
    try {
      writer?.releaseLock();
    } catch {
      /* already released */
    }
    try {
      await this.port.close();
    } catch {
      /* already closed */
    }
  }
}
