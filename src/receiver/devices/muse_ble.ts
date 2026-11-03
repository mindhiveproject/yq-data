import { MuseAthenaClient, MuseClient, MuseDeviceInfo, MUSE_SERVICE } from "muse-jsx";

import { ChannelInfo, Modality } from "../../data_stream.interface";
import { StreamOptions } from "../base_receiver";

/** Carries every sensor on an Athena; absent on earlier models. */
const ATHENA_DATA_CHARACTERISTIC = "273e0013-4c4d-454d-96be-f03bac821358";
/** Carries TP9 on a Muse 2 or classic Muse S. */
const CLASSIC_EEG_CHARACTERISTIC = "273e0003-4c4d-454d-96be-f03bac821358";

/** The two Bluetooth protocols a Muse can speak. */
export type MuseGeneration = "classic" | "athena";

/** The slice of a GATT server used to tell the generations apart. */
interface MuseGatt {
  disconnect(): void;
  getPrimaryService(service: number): Promise<{
    getCharacteristics(): Promise<Array<{ uuid: string }>>;
  }>;
}

/** The slice of `navigator.bluetooth` used to find a headband. */
interface BluetoothLike {
  requestDevice(options: { filters: Array<{ services: number[] }> }): Promise<{
    name?: string;
    gatt?: { connect(): Promise<MuseGatt> };
  }>;
}

/** Publishes channel-major samples from a driver onto the receiver's stream. */
export type MusePublish = (
  modality: Modality,
  data: number[][],
  deviceTime: number
) => void;

/** One generation's protocol, behind the single {@link MuseReceiver}. */
export interface MuseDriver {
  readonly deviceName: string;
  readonly modalities: Modality[];
  readonly client: MuseClient | MuseAthenaClient;
  readonly additionalInfo: MuseDeviceInfo | undefined;

  /** Hands the headband to the client. Bounded by the connection timeout. */
  connect(gatt: unknown): Promise<void>;
  /** Whatever follows a connection and can take its own time. */
  ready(): Promise<void>;
  streams(): StreamOptions[];
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  disconnect(): void;
}

export function toChannelInfo(labels: string[], unit?: string): ChannelInfo[] {
  return labels.map((label, index) => ({
    index,
    label,
    ...(unit ? { unit } : {}),
  }));
}

/**
 * Which generation a headband is, from the characteristics it exposes.
 *
 * Naming a generation skips the guess but not the check: decoding one
 * generation's packets as the other's yields noise without an error, so a
 * headband that plainly is not what was named is refused.
 */
function generationOf(
  uuids: string[],
  model: MuseGeneration | "auto",
  name: string
): MuseGeneration {
  const hasAthena = uuids.includes(ATHENA_DATA_CHARACTERISTIC);
  const hasClassic = uuids.includes(CLASSIC_EEG_CHARACTERISTIC);

  if (model === "athena") {
    if (!hasAthena) throw new Error(`${name} is not a Muse S Athena.`);
    return "athena";
  }
  if (model === "classic") {
    if (hasAthena && !hasClassic) {
      throw new Error(`${name} is a Muse S Athena, not a Muse 2 or classic Muse S.`);
    }
    return "classic";
  }

  if (hasClassic) return "classic";
  if (hasAthena) return "athena";
  throw new Error(`${name} does not look like any Muse this package knows.`);
}

/**
 * Opens the browser's Bluetooth chooser, connects to the headband picked and
 * works out which generation it is.
 *
 * The chooser is opened here rather than left to muse-jsx, whose `connect()`
 * silently takes the first Muse this site was ever granted, which is the wrong
 * headband as soon as a room has two.
 */
export async function requestMuseGatt(
  model: MuseGeneration | "auto"
): Promise<{ gatt: MuseGatt; generation: MuseGeneration }> {
  const bluetooth = (globalThis as { navigator?: { bluetooth?: BluetoothLike } })
    .navigator?.bluetooth;
  if (!bluetooth) {
    throw new Error(
      "Web Bluetooth is not available here. Use a Chromium browser over HTTPS or localhost."
    );
  }

  const device = await bluetooth.requestDevice({
    filters: [{ services: [MUSE_SERVICE] }],
  });
  const gatt = await device.gatt!.connect();

  try {
    const service = await gatt.getPrimaryService(MUSE_SERVICE);
    const uuids = (await service.getCharacteristics()).map((c) => c.uuid);
    const generation = generationOf(uuids, model, device.name ?? "This headband");
    return { gatt, generation };
  } catch (error) {
    gatt.disconnect();
    throw error;
  }
}

/** Rejects if `connecting` has not settled within `timeoutMs`. */
export async function museConnectionWithin(
  connecting: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`Muse connection timed out after ${timeoutMs / 1000} seconds.`)
        );
      }, timeoutMs);
    });
    await Promise.race([connecting, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
