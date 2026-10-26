import { WireCodec } from "./transport";

/** The slice of `@msgpack/msgpack` this package uses. */
interface MsgpackModule {
  encode(value: unknown, options?: { forceFloat32?: boolean }): Uint8Array;
  decode(buffer: ArrayLike<number> | ArrayBufferView): unknown;
}

/** A {@link WireCodec} that has to fetch something before it can run. */
export interface LoadableCodec extends WireCodec {
  /** Resolves once `encode` and `decode` can be called synchronously. */
  load(): Promise<void>;
}

let msgpack: MsgpackModule | undefined;
let loading: Promise<void> | undefined;

function loaded(): MsgpackModule {
  if (!msgpack) {
    throw new Error(
      "MessagePack is not loaded yet. Await transport.ready() or loadMsgpack() first."
    );
  }
  return msgpack;
}

/**
 * Loads `@msgpack/msgpack`, an optional peer dependency.
 *
 * Imported lazily, like `jszip` and `papaparse`, so a page that never talks to
 * a microcontroller does not pay for it. Safe to call repeatedly.
 */
export function loadMsgpack(): Promise<void> {
  if (msgpack) return Promise.resolve();
  loading ??= (async () => {
    try {
      msgpack = (await import("@msgpack/msgpack")) as unknown as MsgpackModule;
    } catch (error) {
      loading = undefined;
      throw new Error(
        "Talking to a microcontroller needs the optional @msgpack/msgpack package: " +
          "npm install @msgpack/msgpack"
      );
    }
  })();
  return loading;
}

/**
 * MessagePack codec for `yq-arduino`.
 *
 * Floats go out as float32 — a device only has to parse one width, and scale
 * and offset do not need more. Decoding accepts either.
 */
export const msgpackCodec: LoadableCodec = {
  load: loadMsgpack,
  encode(value: unknown): Uint8Array {
    return loaded().encode(value, { forceFloat32: true });
  },
  decode(data: unknown): unknown {
    if (!(data instanceof Uint8Array)) {
      throw new Error("msgpackCodec decodes bytes.");
    }
    return loaded().decode(data);
  },
};
