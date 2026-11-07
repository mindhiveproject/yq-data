import { ByteTransport, ByteTransportOptions } from "./byte_transport";

/** A full 128-bit UUID, or a short one such as `0xffe0`. */
export type BluetoothUUID = string | number;

/** Nordic UART Service, the de facto standard for a byte pipe over BLE. */
export const NORDIC_UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
/** The characteristic the app writes to. */
export const NORDIC_UART_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** The characteristic the device notifies on. */
export const NORDIC_UART_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

/** Bytes that fit one write at the smallest MTU Bluetooth allows. */
const DEFAULT_CHUNK_SIZE = 20;
/** Largest value a characteristic can hold, by the Bluetooth specification. */
const MAX_CHUNK_SIZE = 512;

/** The slice of a Web Bluetooth characteristic this transport drives. */
export interface BluetoothCharacteristicLike {
  readonly properties: {
    readonly write?: boolean;
    readonly writeWithoutResponse?: boolean;
    readonly notify?: boolean;
    readonly indicate?: boolean;
  };
  readonly value?: DataView | null;
  startNotifications(): Promise<unknown>;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse(value: Uint8Array): Promise<void>;
  addEventListener(type: "characteristicvaluechanged", listener: () => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: () => void): void;
}

/** The slice of a Web Bluetooth GATT service this transport drives. */
export interface BluetoothServiceLike {
  getCharacteristic(uuid: BluetoothUUID): Promise<BluetoothCharacteristicLike>;
}

/** The slice of a Web Bluetooth GATT server this transport drives. */
export interface BluetoothServerLike {
  connect(): Promise<BluetoothServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: BluetoothUUID): Promise<BluetoothServiceLike>;
}

/** The slice of a Web Bluetooth `BluetoothDevice` this transport drives. */
export interface BluetoothDeviceLike {
  readonly name?: string;
  readonly gatt?: BluetoothServerLike;
  addEventListener(type: "gattserverdisconnected", listener: () => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: () => void): void;
}

/** One way a device can match in the browser's chooser. */
export interface BluetoothDeviceFilter {
  services?: BluetoothUUID[];
  name?: string;
  namePrefix?: string;
}

/** What is asked of `navigator.bluetooth.requestDevice()`. */
export interface BluetoothRequestDeviceOptions {
  filters: BluetoothDeviceFilter[];
  exclusionFilters?: BluetoothDeviceFilter[];
  optionalServices: BluetoothUUID[];
}

/** The slice of `navigator.bluetooth` used to find a device. */
export interface BluetoothLike {
  requestDevice(options: BluetoothRequestDeviceOptions): Promise<BluetoothDeviceLike>;
}

export interface BluetoothTransportOptions extends ByteTransportOptions {
  /** The service to open. Default: the Nordic UART Service. */
  service?: BluetoothUUID;
  /**
   * The characteristic the app writes to. Default: Nordic UART RX. Named from
   * the device's side, like the sketch's `YQ_BLE_RX_UUID`.
   */
  rx?: BluetoothUUID;
  /**
   * The characteristic the device notifies on. Default: Nordic UART TX. May be
   * the same one as `rx`, as on an HM-10.
   */
  tx?: BluetoothUUID;
  /**
   * Bytes per write. Default 20, which fits any link. A page cannot read or set
   * the MTU, so raise this only when you know what the link negotiated.
   */
  chunkSize?: number;
  /**
   * Whether to wait for an acknowledgement of each write. By default, only when
   * the characteristic cannot do without one, because waiting is much slower.
   */
  withResponse?: boolean;
  /**
   * Bytes that may wait to be written. Default 1024. A frame that would exceed
   * this is dropped whole and counted in `stats.queueDropped`, so a sink written
   * faster than the link carries lags by a bounded amount.
   */
  maxQueuedBytes?: number;
  /** How long to wait for the link to open, in ms. Default 10000. */
  connectTimeout?: number;
}

export interface BluetoothRequestOptions extends BluetoothTransportOptions {
  /** What the chooser lists. Default: devices advertising `service`. */
  filters?: BluetoothDeviceFilter[];
  /** What the chooser hides, such as `[{ namePrefix: "EmotiBit" }]`. */
  exclusionFilters?: BluetoothDeviceFilter[];
  /** Defaults to `navigator.bluetooth`. */
  bluetooth?: BluetoothLike;
}

export type BluetoothStats = ByteTransport["stats"] & {
  /** Frames dropped because too many bytes were waiting to be written. */
  queueDropped: number;
};

function resolveBluetooth(bluetooth?: BluetoothLike): BluetoothLike {
  const found =
    bluetooth ?? (globalThis as { navigator?: { bluetooth?: BluetoothLike } }).navigator?.bluetooth;
  if (!found) {
    throw new Error(
      "Web Bluetooth is not available here. Use a Chromium browser over HTTPS or localhost."
    );
  }
  return found;
}

/** Web Bluetooth rejects a UUID with capitals, the way sketches often write them. */
function normalize<T extends BluetoothUUID>(uuid: T): T {
  return (typeof uuid === "string" ? uuid.toLowerCase() : uuid) as T;
}

function normalizeFilter(filter: BluetoothDeviceFilter): BluetoothDeviceFilter {
  return filter.services ? { ...filter, services: filter.services.map(normalize) } : filter;
}

/**
 * A transport over a Bluetooth Low Energy UART, through Web Bluetooth.
 *
 * ```ts
 * const transport = await BluetoothTransport.request();
 * const board = new ArduinoReceiver(transport);
 * await board.connect();
 * ```
 *
 * `request()` shows the browser's chooser, which needs a user gesture — call it
 * from a click handler. It lists whatever advertises the service, and the Nordic
 * UART Service is not unique to yq-arduino, so narrow it with `filters` or
 * `exclusionFilters` if other devices are around.
 *
 * Other UARTs need only their UUIDs: an HM-10 is
 * `{ service: 0xffe0, rx: 0xffe1, tx: 0xffe1 }`. A device that does not speak
 * `yq-arduino` framing can pass its own `framing` and `codec`.
 *
 * **Chunks.** The pipe is the same as a serial port's, but it arrives in
 * notifications, so a frame may span several of them or several may share one.
 * The page cannot learn the MTU, so writes stay at `chunkSize`.
 *
 * **Reconnecting.** A device may lose the link at any time, and `isOpen$` is how
 * to find out. Calling `ready()` again connects again with no chooser or gesture,
 * so a dropped `ArduinoReceiver` only needs another `connect()` and
 * `startStream()`. `close()` is final, as on the other transports; to come back
 * after it, use `new BluetoothTransport(transport.device)`. There is no automatic
 * reconnect.
 *
 * Web Bluetooth limits this to Chrome-based browsers.
 */
export class BluetoothTransport extends ByteTransport {
  readonly kind = "bluetooth" as const;

  /** The device, which can be handed to a new transport without the chooser. */
  readonly device: BluetoothDeviceLike;

  private readonly serviceUUID: BluetoothUUID;
  private readonly rxUUID: BluetoothUUID;
  private readonly txUUID: BluetoothUUID;
  private readonly chunkSize: number;
  private readonly writeWithResponse?: boolean;
  private readonly maxQueuedBytes: number;
  private readonly connectTimeout: number;

  private rx?: BluetoothCharacteristicLike;
  private tx?: BluetoothCharacteristicLike;
  private withResponse = false;
  private opening?: Promise<void>;
  private closedByUs = false;
  private writeChain: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queueDropped = 0;
  private teardown?: Promise<void>;

  private readonly onValue = () => {
    const value = this.tx?.value;
    if (value) {
      this.feed(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  };

  private readonly onDisconnect = () => {
    this.detach();
    this.opening = undefined;
    this.setOpen(false);
  };

  constructor(device: BluetoothDeviceLike, options: BluetoothTransportOptions = {}) {
    super(options);
    this.device = device;
    this.serviceUUID = normalize(options.service ?? NORDIC_UART_SERVICE);
    this.rxUUID = normalize(options.rx ?? NORDIC_UART_RX);
    this.txUUID = normalize(options.tx ?? NORDIC_UART_TX);
    this.chunkSize = Math.min(
      Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE)),
      MAX_CHUNK_SIZE
    );
    this.writeWithResponse = options.withResponse;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 1024;
    this.connectTimeout = options.connectTimeout ?? 10000;
  }

  /** Asks the user to pick a device. Needs a user gesture. */
  static async request(options: BluetoothRequestOptions = {}): Promise<BluetoothTransport> {
    const bluetooth = resolveBluetooth(options.bluetooth);
    const service = normalize(options.service ?? NORDIC_UART_SERVICE);
    const device = await bluetooth.requestDevice({
      filters: options.filters?.map(normalizeFilter) ?? [{ services: [service] }],
      // Filtering by name alone would otherwise leave the service out of reach.
      optionalServices: [service],
      ...(options.exclusionFilters
        ? { exclusionFilters: options.exclusionFilters.map(normalizeFilter) }
        : {}),
    });
    return new BluetoothTransport(device, options);
  }

  /** Bytes, frames and drops since this transport was created. */
  get stats(): BluetoothStats {
    return { ...super.stats, queueDropped: this.queueDropped };
  }

  /** Opens the link. Resolves when frames can flow; rejects if it cannot open. */
  ready(): Promise<void> {
    if (this.closedByUs) {
      return Promise.reject(new Error("Transport has been closed."));
    }
    this.opening ??= this.open();
    return this.opening;
  }

  /** Resolves once a `close()` has finished releasing the link. */
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
    if (this.queuedBytes + bytes.length > this.maxQueuedBytes) {
      this.queueDropped++;
      return this.writeChain;
    }

    // Queued because a GATT operation fails while another is under way. Whole
    // frames, in order, so one that is dropped costs the far end nothing else.
    this.queuedBytes += bytes.length;
    this.writeChain = this.writeChain
      .then(() => this.writeChunks(bytes))
      .catch((error) => {
        // A write that fails because the link just dropped is not news.
        if (this.isOpen) console.warn("BluetoothTransport: write failed.", error);
      })
      .then(() => {
        this.queuedBytes -= bytes.length;
      });
    return this.writeChain;
  }

  private async writeChunks(bytes: Uint8Array): Promise<void> {
    for (let start = 0; start < bytes.length; start += this.chunkSize) {
      const rx = this.rx;
      if (!rx) return;
      const chunk = bytes.subarray(start, start + this.chunkSize);
      await (this.withResponse
        ? rx.writeValueWithResponse(chunk)
        : rx.writeValueWithoutResponse(chunk));
    }
  }

  private async open(): Promise<void> {
    const gatt = this.device.gatt;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await this.prepare();
      if (!gatt) throw new Error("This Bluetooth device has no GATT server.");

      this.device.addEventListener("gattserverdisconnected", this.onDisconnect);

      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`The Bluetooth link did not open within ${this.connectTimeout} ms.`)
            ),
          this.connectTimeout
        );
      });
      await Promise.race([this.attach(gatt), timeout]);

      // close() may have come while the link was opening.
      if (this.closedByUs) throw new Error("Transport has been closed.");
    } catch (error) {
      this.detach();
      this.opening = undefined;
      gatt?.disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
    }

    this.markOpen();
  }

  private async attach(gatt: BluetoothServerLike): Promise<void> {
    const server = await gatt.connect();
    const service = await server.getPrimaryService(this.serviceUUID);
    const tx = await service.getCharacteristic(this.txUUID);
    const rx = this.rxUUID === this.txUUID ? tx : await service.getCharacteristic(this.rxUUID);

    if (!tx.properties.notify && !tx.properties.indicate) {
      throw new Error("The device's TX characteristic does not notify.");
    }

    const withResponse = this.writeWithResponse ?? !rx.properties.writeWithoutResponse;
    if (withResponse ? !rx.properties.write : !rx.properties.writeWithoutResponse) {
      throw new Error("The device's RX characteristic cannot be written this way.");
    }
    this.withResponse = withResponse;

    // Subscribed before anything is sent, or the first answer would be lost.
    this.tx = tx;
    tx.addEventListener("characteristicvaluechanged", this.onValue);
    await tx.startNotifications();
    this.rx = rx;
  }

  /** Stops listening, and leaves nothing for a queued write to use. */
  private detach(): void {
    this.device.removeEventListener("gattserverdisconnected", this.onDisconnect);
    this.tx?.removeEventListener("characteristicvaluechanged", this.onValue);
    this.tx = undefined;
    this.rx = undefined;
  }

  private async release(): Promise<void> {
    // Let queued writes finish first, so a final `stop` message is not lost.
    await this.writeChain;
    this.detach();
    this.device.gatt?.disconnect();
  }
}
