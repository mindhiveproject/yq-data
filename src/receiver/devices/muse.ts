import { AthenaPreset, MuseAthenaClient, MuseClient, MuseDeviceInfo } from "muse-jsx";

import { Modality } from "../../data_stream.interface";
import { BaseReceiver, StreamOptions } from "../base_receiver";
import { AthenaMuseDriver } from "./muse_athena";
import {
  MuseDriver,
  MuseGeneration,
  museConnectionWithin,
  requestMuseGatt,
} from "./muse_ble";
import { ClassicMuseDriver } from "./muse_classic";

export type { AthenaPreset };

export interface MuseOptions {
  /**
   * Which generation to expect. By default the headband picked in the chooser
   * decides.
   *
   * Name one for an exact layout from `expectedStreams()` before connecting;
   * an undecided receiver previews a Muse 2's. Naming one also refuses a
   * headband that is plainly the other generation.
   */
  model?: MuseGeneration | "auto";
  /** Publish optical channels. Default `true`. */
  enablePPG?: boolean;
  /** Publish the auxiliary EEG channels. Default `false`. */
  enableAUX?: boolean;
  /**
   * What a Muse S Athena streams; other models ignore it. Defaults to `p1041`,
   * 8 EEG and 16 optical channels, the only presets with red LEDs and ambient
   * channels, or `p21` when `enablePPG` is false.
   */
  preset?: AthenaPreset;
}

/**
 * Muse headband receiver, over Web Bluetooth, for a Muse 2, a classic Muse S or
 * a Muse S Athena. Web Bluetooth limits this to Chrome-based browsers.
 *
 * The two generations speak different Bluetooth protocols, both handled by
 * muse-jsx. Which one a headband speaks is found on connecting, so the same
 * code and the same graph serve either.
 *
 * @see https://github.com/fuji3to4/muse-jsx
 *
 * Emits raw EEG at 256 Hz and, when enabled, raw optical channels at 64 Hz as
 * `Modality.PPG`. An Athena also emits accelerometer and gyroscope at 52 Hz.
 * Derived quantities — band power, heart rate — are deliberately not computed
 * here; build a {@link Pipeline} over these raw streams instead, so the same
 * analysis code serves every device.
 *
 * The PPG stream is the raw sensor, so pick the pulse channel by label before
 * heart rate. Its name differs by generation; list both, as a label the stream
 * does not have is skipped: `labels: ["infrared", "LI_RED"]`.
 */
export class MuseReceiver extends BaseReceiver {
  deviceName: string = "Muse";
  deviceID: string | number | undefined;
  modalities: Modality[] = [];

  private readonly options: Required<Pick<MuseOptions, "enablePPG" | "enableAUX">> &
    Pick<MuseOptions, "preset">;
  private readonly model: MuseGeneration | "auto";

  private readonly drivers = new Map<MuseGeneration, MuseDriver>();
  /** Connected, or else what `expectedStreams()` should preview. */
  private driver!: MuseDriver;

  /**
   * @param options - Settings. A boolean is the older form of `enablePPG`.
   * @param enableAUX - The older form of `options.enableAUX`.
   */
  constructor(options: MuseOptions | boolean = {}, enableAUX: boolean = false) {
    super();

    const settings: MuseOptions =
      typeof options === "boolean" ? { enablePPG: options, enableAUX } : options;

    this.options = {
      enablePPG: settings.enablePPG ?? true,
      enableAUX: settings.enableAUX ?? false,
      preset: settings.preset,
    };
    this.model = settings.model ?? "auto";

    this.useDriver(this.model === "athena" ? "athena" : "classic");
  }

  /** The muse-jsx client for the current generation. */
  get muse(): MuseClient | MuseAthenaClient {
    return this.driver.client;
  }

  /** What the headband reports about itself, once it has answered. */
  get additionalInfo(): MuseDeviceInfo | undefined {
    return this.driver.additionalInfo;
  }

  private useDriver(generation: MuseGeneration): MuseDriver {
    let driver = this.drivers.get(generation);

    if (!driver) {
      const publish = (modality: Modality, data: number[][], deviceTime: number) =>
        this.update({ modality }, data, deviceTime);

      driver =
        generation === "athena"
          ? new AthenaMuseDriver(this.options, publish)
          : new ClassicMuseDriver(this.options, publish);

      this.drivers.set(generation, driver);
      driver.client.connectionStatus.subscribe((connection) =>
        this.isConnected$.next(connection)
      );
    }

    this.driver = driver;
    this.deviceName = driver.deviceName;
    this.modalities = driver.modalities;
    return driver;
  }

  public async connect(timeoutDuration = 10000): Promise<void> {
    if (this.isConnected) {
      console.warn("Already connected to Muse device.");
      return;
    }

    try {
      await museConnectionWithin(
        requestMuseGatt(this.model).then(({ gatt, generation }) =>
          this.useDriver(generation).connect(gatt)
        ),
        timeoutDuration
      );
    } catch (error) {
      console.error("Failed to connect to Muse device:", error);
      this.isConnected$.next(false);
      throw error;
    }

    if (this.driver.client.deviceName) {
      this.deviceID = this.driver.client.deviceName;
    }

    await this.driver.ready();

    for (const options of this.plannedStreams()) this.ensureStream(options);
  }

  protected plannedStreams(): StreamOptions[] {
    return this.driver.streams();
  }

  public async startStream(): Promise<void> {
    await this.driver.startStream();
  }

  public async stopStream(): Promise<void> {
    await this.driver.stopStream();
  }

  public async disconnect(): Promise<void> {
    this.driver.disconnect();
  }
}
