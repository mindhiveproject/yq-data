import { BaseTransport } from "./transport";

/**
 * An in-process link between two halves.
 *
 * `MemoryTransport.pair()` returns two connected transports; a value sent on
 * one is delivered synchronously to the other's listeners. Nothing is
 * serialized, so a {@link import("../data_stream.interface").DataPacket} passes
 * with its `Float32Array` untouched.
 *
 * Two uses: it is the transport the tests run against, and it wires a pipeline
 * output back to a source node in the same page without a real channel — a
 * `StreamTransmitter` on one half, a `RemoteStreamReceiver` on the other.
 *
 * ```ts
 * const [a, b] = MemoryTransport.pair();
 * const out = new StreamTransmitter(a);
 * const back = new RemoteStreamReceiver(b);
 * ```
 */
export class MemoryTransport extends BaseTransport {
  readonly kind = "memory" as const;
  readonly structuredClone = true;

  private peer?: MemoryTransport;

  /** Two transports joined to each other, both open. */
  static pair(): [MemoryTransport, MemoryTransport] {
    const a = new MemoryTransport();
    const b = new MemoryTransport();
    a.peer = b;
    b.peer = a;
    a.setOpen(true);
    b.setOpen(true);
    return [a, b];
  }

  send(value: unknown): void {
    if (!this.isOpen) return;
    this.peer?.emit(value);
  }

  /** Closes both halves — a memory link has no independent lifetimes. */
  close(): void {
    if (!this.isOpen) return;
    this.setOpen(false);
    this.peer?.close();
  }
}
