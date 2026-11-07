/**
 * A Bluetooth Low Energy UART that lives in memory, for running
 * `BluetoothTransport` with no radio.
 *
 * It holds the page to what makes Web Bluetooth awkward: capital letters in a
 * UUID throw, a second GATT operation fails while one is under way, a write
 * without response must fit the MTU, and nothing arrives before
 * `startNotifications()`.
 */
import {
  BluetoothCharacteristicLike,
  BluetoothDeviceLike,
  BluetoothServerLike,
  BluetoothServiceLike,
  BluetoothUUID,
  NORDIC_UART_RX,
  NORDIC_UART_SERVICE,
  NORDIC_UART_TX,
} from "./bluetooth";

/** Largest value a characteristic can hold. */
const MAX_VALUE = 512;

export interface SimulatedBluetoothOptions {
  name?: string;
  /** Default: the Nordic UART Service. */
  service?: BluetoothUUID;
  /** Default: Nordic UART RX. */
  rx?: BluetoothUUID;
  /** Default: Nordic UART TX. May equal `rx`. */
  tx?: BluetoothUUID;
  /** Default 23, the smallest there is: 20 bytes per notification. */
  mtu?: number;
  /** Whether the RX characteristic takes acknowledged writes. Default `true`. */
  write?: boolean;
  /** Whether the RX characteristic takes unacknowledged writes. Default `true`. */
  writeWithoutResponse?: boolean;
  /** How long each write takes, in ms. Default 0. */
  writeDelay?: number;
  /** Set `true` to make a device whose connection never completes. */
  neverConnects?: boolean;
}

/** One write the app made. */
export interface SimulatedWrite {
  bytes: Uint8Array;
  withResponse: boolean;
}

/** Short UUIDs and long ones name the same thing. */
function canonical(uuid: BluetoothUUID): string {
  if (typeof uuid === "number") {
    return `${uuid.toString(16).padStart(8, "0")}-0000-1000-8000-00805f9b34fb`;
  }
  if (/[A-Z]/.test(uuid)) {
    throw new TypeError(`Invalid Bluetooth UUID: "${uuid}" has capital letters.`);
  }
  return uuid;
}

class SimulatedCharacteristic implements BluetoothCharacteristicLike {
  value: DataView | null = null;
  subscribed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly properties: BluetoothCharacteristicLike["properties"],
    private readonly device: SimulatedBluetoothDevice
  ) {}

  async startNotifications(): Promise<this> {
    this.subscribed = true;
    return this;
  }

  writeValueWithResponse(value: Uint8Array): Promise<void> {
    return this.device.receive(value, true);
  }

  writeValueWithoutResponse(value: Uint8Array): Promise<void> {
    return this.device.receive(value, false);
  }

  addEventListener(_type: "characteristicvaluechanged", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "characteristicvaluechanged", listener: () => void): void {
    this.listeners.delete(listener);
  }

  dispatch(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * An in-memory {@link BluetoothDeviceLike}. Bytes the app writes go to
 * `onWrite`; bytes sent with {@link push} arrive as notifications.
 */
export class SimulatedBluetoothDevice implements BluetoothDeviceLike {
  readonly name?: string;
  readonly gatt: BluetoothServerLike;

  /** Receives every chunk the app writes. */
  onWrite: (bytes: Uint8Array) => void = () => {};
  /** Called when the app connects. */
  onOpen: () => void = () => {};
  /** Called when the link closes, from either end. */
  onClose: () => void = () => {};

  /** Every write the app made, in order. */
  readonly writes: SimulatedWrite[] = [];
  /** Whether a central is connected. */
  connected = false;

  private readonly options: SimulatedBluetoothOptions;
  private readonly mtu: number;
  private readonly rx: SimulatedCharacteristic;
  private readonly tx: SimulatedCharacteristic;
  private readonly listeners = new Set<() => void>();
  private writing = false;

  constructor(options: SimulatedBluetoothOptions = {}) {
    this.options = options;
    this.name = options.name;
    this.mtu = options.mtu ?? 23;

    const rxProperties = {
      write: options.write ?? true,
      writeWithoutResponse: options.writeWithoutResponse ?? true,
    };
    this.tx = new SimulatedCharacteristic({ notify: true }, this);
    this.rx = this.sameCharacteristic
      ? this.tx
      : new SimulatedCharacteristic(rxProperties, this);
    if (this.sameCharacteristic) {
      Object.assign(this.tx.properties, rxProperties);
    }

    const service = this.service();
    const server: BluetoothServerLike = {
      connect: () => this.connect(server),
      disconnect: () => this.close(),
      getPrimaryService: async (uuid) => {
        this.requireConnected();
        if (canonical(uuid) !== canonical(options.service ?? NORDIC_UART_SERVICE)) {
          throw new Error("NotFoundError: no service matching that UUID.");
        }
        return service;
      },
    };
    this.gatt = server;
  }

  addEventListener(_type: "gattserverdisconnected", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "gattserverdisconnected", listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** Whether the app has subscribed to notifications. */
  get subscribed(): boolean {
    return this.tx.subscribed;
  }

  /**
   * Sends bytes to the app, split into as many notifications as the MTU needs,
   * the way the Arduino library's `YQBleStream` does.
   */
  push(bytes: Uint8Array): void {
    const room = this.mtu - 3;
    for (let start = 0; start < bytes.length; start += room) {
      this.notify(bytes.slice(start, start + room));
    }
  }

  /**
   * Sends one notification. Anything past the MTU is lost, as with the ESP32
   * core's `notify()`, which truncates a long value.
   */
  notify(bytes: Uint8Array): void {
    const chunk = bytes.slice(0, this.mtu - 3);
    queueMicrotask(() => {
      if (this.connected && this.tx.subscribed) this.tx.dispatch(chunk);
    });
  }

  /** The link is lost from the device's side: out of range, or powered off. */
  drop(): void {
    this.close();
  }

  /** @internal What a characteristic does with a value written to it. */
  async receive(value: Uint8Array, withResponse: boolean): Promise<void> {
    this.requireConnected();
    if (this.writing) {
      throw new Error("NetworkError: GATT operation already in progress.");
    }

    const allowed = withResponse
      ? this.rx.properties.write
      : this.rx.properties.writeWithoutResponse;
    if (!allowed) {
      throw new Error("NotSupportedError: the characteristic does not allow this write.");
    }
    if (value.length > (withResponse ? MAX_VALUE : this.mtu - 3)) {
      throw new Error("NotSupportedError: the value does not fit.");
    }

    this.writing = true;
    const bytes = value.slice();
    if (this.options.writeDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.options.writeDelay));
    } else {
      await Promise.resolve();
    }
    this.writing = false;
    this.requireConnected();

    this.writes.push({ bytes, withResponse });
    this.onWrite(bytes);
  }

  private get sameCharacteristic(): boolean {
    const { rx = NORDIC_UART_RX, tx = NORDIC_UART_TX } = this.options;
    return canonical(rx) === canonical(tx);
  }

  private service(): BluetoothServiceLike {
    const { rx = NORDIC_UART_RX, tx = NORDIC_UART_TX } = this.options;
    return {
      getCharacteristic: async (uuid) => {
        this.requireConnected();
        if (canonical(uuid) === canonical(tx)) return this.tx;
        if (canonical(uuid) === canonical(rx)) return this.rx;
        throw new Error("NotFoundError: no characteristic matching that UUID.");
      },
    };
  }

  private async connect(server: BluetoothServerLike): Promise<BluetoothServerLike> {
    if (this.options.neverConnects) await new Promise(() => {});
    if (!this.connected) {
      this.connected = true;
      this.onOpen();
    }
    return server;
  }

  private close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.writing = false;
    this.tx.subscribed = false;
    this.rx.subscribed = false;
    this.onClose();
    this.listeners.forEach((listener) => listener());
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("NetworkError: GATT server is disconnected.");
  }
}
