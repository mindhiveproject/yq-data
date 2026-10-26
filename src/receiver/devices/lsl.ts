import { Modality } from "../../data_stream.interface";
import { Transport } from "../../transport/transport";
import { WebSocketTransport } from "../../transport/websocket";
import { LSLProtocol } from "../../transport/lsl_protocol";
import { RemoteStreamReceiver } from "./remote";

export interface LSLOptions {
  /** Reconnect automatically after an unexpected close. Default `true`. */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms; doubles up to `maxReconnectDelay`. */
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  /**
   * Makes the transport for a relay address. Defaults to a `WebSocketTransport`.
   * Pass your own to reach a relay some other way — through a worker, say, or
   * in a test.
   */
  transport?: (address: string) => Transport;
}

/**
 * Lab Streaming Layer receiver, over a relay.
 *
 * LSL itself is a native protocol with no browser binding, so this connects to
 * a relay on the machine the streams are on, which forwards them as JSON. That
 * message shape is what LSLWebsocketMirror produces — a Python script the user
 * runs — and any relay emitting the same shape works.
 *
 * ```ts
 * const lsl = new LSLReceiver();
 * await lsl.connect("ws://localhost:8080");
 * lsl.startStream();
 * ```
 *
 * What the relay says is read by {@link LSLProtocol}; this is a
 * `RemoteStreamReceiver` speaking it over a `WebSocketTransport`, which owns
 * the reconnecting. One relay commonly carries several devices, so each LSL
 * stream becomes its own yq-data stream, identified by that stream's
 * `source_id`.
 *
 * The same protocol works anywhere a transport does — including as a pipeline
 * `receive` node, by setting `transport.protocol = new LSLProtocol()`.
 *
 * @see https://github.com/esromerog/LSLWebsocketMirror
 * @see https://labstreaminglayer.readthedocs.io
 */
export class LSLReceiver extends RemoteStreamReceiver {
  deviceName: string = "LSL";
  modalities: Modality[] = [Modality.UNKNOWN];

  /** What the relay announced: its stream keys, and the marker codes in use. */
  readonly protocol: LSLProtocol;

  /** Shared with the transport factory, which runs on `connect()`. */
  private readonly address: { current: string };

  constructor(options: LSLOptions = {}) {
    const address = { current: "" };
    const protocol = new LSLProtocol();
    const { transport: makeTransport, ...reconnect } = options;

    super(
      () =>
        makeTransport
          ? makeTransport(address.current)
          : new WebSocketTransport(address.current, reconnect),
      {
        protocol,
        deviceID: "LSL",
        // The relay's clock is the sender's, never ours.
        trustRemoteClock: false,
      }
    );

    this.protocol = protocol;
    this.address = address;
  }

  /** Stream keys the relay has announced so far. */
  get discoveredStreams(): string[] {
    return this.protocol.streamKeys;
  }

  /**
   * Connects to the relay. The address is remembered, so calling it again after
   * a `disconnect()` can leave it out.
   */
  public async connect(socketURL?: string): Promise<void> {
    if (this.isConnected) {
      console.warn("LSL receiver is already connected.");
      return;
    }

    if (socketURL) this.address.current = socketURL;
    if (!this.address.current) {
      throw new Error(
        "LSLReceiver.connect() needs the relay's address, e.g. ws://localhost:8080."
      );
    }

    try {
      await super.connect();
    } catch {
      throw new Error("Unable to reach LSL relay.");
    }
  }
}
