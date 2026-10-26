import { Transport } from "../../transport/transport";
import {
  ArduinoProtocol,
  ArduinoStream,
  ARDUINO_PROTOCOL,
  ARDUINO_PROTOCOL_VERSION,
  SinkRoute,
} from "../../transport/arduino_protocol";
import { RemoteStreamOptions, RemoteStreamReceiver } from "./remote";

export interface ArduinoOptions
  extends Omit<RemoteStreamOptions, "protocol" | "trustRemoteClock"> {
  /**
   * How often to repeat `hello` while waiting for the board, in ms. Default 500.
   *
   * Opening a serial port resets an Uno and most ESP32 dev boards, which then
   * ignore input for a second or two, so the first `hello` is usually lost.
   */
  helloInterval?: number;
  /** How long to wait for the board to describe itself, in ms. Default 5000. */
  handshakeTimeout?: number;
  /**
   * Which sink each packet sent on this link goes to. By default, the sink
   * named like the packet's stream. Also settable later as `protocol.route`.
   */
  route?: SinkRoute;
}

/**
 * A board speaking `yq-arduino`, over a serial port or BLE UART.
 *
 * The board announces its own streams — names, modalities, channel layouts,
 * rates, scales — so there is nothing to configure here. Sources become
 * ordinary yq-data streams; sinks are written to.
 *
 * ```ts
 * const transport = await SerialTransport.request();
 * const board = new ArduinoReceiver(transport);
 * await board.connect();          // runs the handshake
 * board.startStream();
 * board.data.subscribe((packet) => ...);
 *
 * board.write("led", 255);        // to a sink
 * ```
 *
 * **It claims its transport**: it sets `transport.protocol` to its own
 * {@link ArduinoProtocol}, so anything else sending on that transport — a
 * `StreamTransmitter`, a pipeline `transmit` node — speaks to the board in its
 * protocol, with no options. Packets go to the sink named like their stream
 * (or wherever `route` says), and everything else is skipped.
 *
 * Attach it to a pipeline by hand, like a Muse:
 * `pipeline.attachReceiver("board", board)`. Pipeline `receive` nodes build a
 * plain `RemoteStreamReceiver`, which cannot run the handshake.
 *
 * Timestamps from the board are filed under `deviceTime`, unwrapped across its
 * 32-bit counter. They are the board's clock, not the page's.
 *
 * @see docs/arduino-protocol.md
 */
export class ArduinoReceiver extends RemoteStreamReceiver {
  deviceName = "Arduino";

  /** The conversation with the board: what it announced, routing, counters. */
  readonly protocol: ArduinoProtocol;

  private readonly helloInterval: number;
  private readonly handshakeTimeout: number;
  private pingSeq = 0;
  private pendingPings = new Map<
    number,
    (deviceTimeMs: number) => void
  >();

  constructor(transport: Transport, options: ArduinoOptions = {}) {
    const { route, ...rest } = options;
    const protocol = new ArduinoProtocol();
    protocol.route = route;
    super(transport, {
      ...rest,
      protocol,
      // Whatever the clocks are, they are not ours.
      trustRemoteClock: false,
      deviceID: options.deviceID ?? "arduino",
    });

    this.protocol = protocol;
    this.helloInterval = options.helloInterval ?? 500;
    this.handshakeTimeout = options.handshakeTimeout ?? 5000;

    // The board is the only thing on the other end of this link.
    transport.protocol = protocol;

    // Streams register under the board's own id, which arrives before them.
    protocol.onBoard = (board) => {
      this.deviceID = board.id;
    };
    protocol.onPong = (seq, deviceTimeMs) => {
      this.pendingPings.get(seq)?.(deviceTimeMs);
      this.pendingPings.delete(seq);
    };
  }

  /** Streams the board sends to the app, as it announced them. */
  get sources(): ArduinoStream[] {
    return this.protocol.sources;
  }

  /** Streams the board accepts from the app, as it announced them. */
  get sinks(): ArduinoStream[] {
    return this.protocol.sinks;
  }

  /**
   * Opens the link and waits for the board to describe itself.
   *
   * Rejects if the board does not answer within `handshakeTimeout`, or speaks
   * a protocol version this package does not.
   */
  public async connect(): Promise<void> {
    if (this.isConnected) return;

    await super.connect();
    try {
      await this.handshake();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  public startStream(): void {
    super.startStream();
    this.transport.send(this.protocol.start());
  }

  public stopStream(): void {
    this.transport.send(this.protocol.stop());
    super.stopStream();
  }

  public async disconnect(): Promise<void> {
    // Tell the board to stop, so it is not left streaming into nothing.
    if (this.transport.isOpen) this.transport.send(this.protocol.stop());
    this.pendingPings.clear();
    await super.disconnect();
  }

  /**
   * Writes values to one of the board's sinks.
   *
   * Values are physical and interleaved — three RGB channels are
   * `[r, g, b, r, g, b, …]`. They are quantised to the sink's format and split
   * across messages if they do not fit one frame. Unknown sinks are ignored,
   * with a warning.
   */
  public write(sink: string, values: number | ArrayLike<number>): void {
    if (!this.protocol.sink(sink)) {
      console.warn(`The board has no sink called "${sink}".`);
      return;
    }
    const array = typeof values === "number" ? [values] : values;
    for (const message of this.protocol.sinkMessages(sink, array)) {
      this.transport.send(message);
    }
  }

  /**
   * Measures the round trip to the board and reads its clock.
   *
   * `deviceTime` is the board's clock in ms, modulo its 32-bit counter. It is
   * for checking that a board is alive and how far away it is; aligning its
   * timestamps with the page's clock is a separate job.
   */
  public ping(timeout = 1000): Promise<{ roundTrip: number; deviceTime: number }> {
    const seq = this.pingSeq++;
    const sentAt = performance.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(seq);
        reject(new Error(`The board did not answer ping within ${timeout} ms.`));
      }, timeout);

      this.pendingPings.set(seq, (deviceTime) => {
        clearTimeout(timer);
        resolve({ roundTrip: performance.now() - sentAt, deviceTime });
      });

      this.transport.send(this.protocol.ping(seq));
    });
  }

  /* ------------------------------- internals ------------------------------- */

  private handshake(): Promise<void> {
    this.protocol.reset();

    return new Promise((resolve, reject) => {
      let interval: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: Error) => {
        clearInterval(interval);
        clearTimeout(timer);
        this.protocol.onReady = undefined;
        this.protocol.onIncompatible = undefined;
        if (error) reject(error);
        else resolve();
      };

      this.protocol.onReady = () => finish();
      this.protocol.onIncompatible = (version) =>
        finish(
          new Error(
            `The board speaks ${ARDUINO_PROTOCOL} v${version}; ` +
              `this package speaks v${ARDUINO_PROTOCOL_VERSION}.`
          )
        );
      const hello = () => this.transport.send(this.protocol.hello());

      timer = setTimeout(
        () =>
          finish(
            new Error(
              `The board did not describe itself within ${this.handshakeTimeout} ms. ` +
                "Check the baud rate and that the sketch calls the library's poll()."
            )
          ),
        this.handshakeTimeout
      );
      interval = setInterval(hello, this.helloInterval);
      hello();
    });
  }
}
