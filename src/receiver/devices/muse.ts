import {
  MuseClient,
  channelNames,
  EEGReading,
  PPGReading,
  MuseDeviceInfo,
} from "muse-js";

import {
  ChannelInfo,
  Modality,
  ProcessingStage,
} from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";
import { map, bufferCount, Subject, Subscription } from "rxjs";

const EEG_SAMPLING_RATE = 256;
const PPG_SAMPLING_RATE = 64;

/**
 * PPG channel layouts differ between Muse models, and the device name is a
 * serial like "Muse-4B2C" rather than the model, so the model is inferred
 * from the name's prefix.
 */
const PPG_CHANNELS: Record<string, string[]> = {
  Muse2: ["ambient", "infrared", "red"],
  MuseS: ["infrared", "green", "unknown"],
};

function ppgChannelsFor(deviceName: string | undefined): string[] {
  if (deviceName && /muse-?s/i.test(deviceName)) return PPG_CHANNELS.MuseS;
  return PPG_CHANNELS.Muse2;
}

function toChannelInfo(labels: string[], unit?: string): ChannelInfo[] {
  return labels.map((label, index) => ({
    index,
    label,
    ...(unit ? { unit } : {}),
  }));
}

/**
 * Muse headband receiver, over Web Bluetooth.
 *
 * The Bluetooth GATT protocol is spoken by muse-js, which handles connection,
 * subscription and decoding of the headband's packed 12-bit samples. Web
 * Bluetooth limits this to Chrome-based browsers.
 *
 * @see https://github.com/urish/muse-js
 *
 * Emits raw EEG at 256 Hz and, when enabled, raw PPG at 64 Hz. Derived
 * quantities — band power, heart rate — are deliberately not computed here;
 * build a {@link Pipeline} over these raw streams instead, so the same
 * analysis code serves every device.
 */
export class MuseReceiver extends BaseReceiver {
  deviceName: string = "Muse";
  deviceID: string | number | undefined;

  modalities: Modality[] = [
    Modality.EEG,
    Modality.PPG,
    Modality.ACCELEROMETER,
    Modality.GYROSCOPE,
  ];

  additionalInfo: MuseDeviceInfo | undefined;
  private _eegData = new Subject<EEGReading>();
  private _ppgData = new Subject<PPGReading>();
  private streamSubscriptions: Subscription[] = [];

  /** 4 electrodes, or 5 when the auxiliary channel is enabled. */
  private eegChannelCount = 4;

  public muse: MuseClient;

  constructor(enablePPG: boolean = true, enableAUX: boolean = false) {
    super();

    const muse = new MuseClient();
    muse.enablePpg = enablePPG;
    muse.enableAux = enableAUX;
    muse.connectionStatus.subscribe((connection) =>
      this.isConnected$.next(connection)
    );

    this.eegChannelCount = enableAUX ? 5 : 4;
    this.muse = muse;
  }

  public async connect(timeoutDuration = 10000): Promise<void> {
    if (this.isConnected) {
      console.warn("Already connected to Muse device.");
      return;
    }

    try {
      // Create a promise that rejects after the specified timeout
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(
            new Error(
              `Muse connection timed out after ${
                timeoutDuration / 1000
              } seconds.`
            )
          );
        }, timeoutDuration)
      );
      await Promise.race([this.muse.connect(), timeoutPromise]);
    } catch (error) {
      console.error("Failed to connect to Muse device:", error);
      this.isConnected$.next(false);
      throw error;
    }

    if (this.muse.deviceName) {
      this.deviceID = this.muse.deviceName;
    }

    this.additionalInfo = await this.muse.deviceInfo();
    this.muse.eegReadings.subscribe(this._eegData);

    if (this.muse.enablePpg) {
      this.muse.ppgReadings.subscribe(this._ppgData);
    }

    // muse-js publishes five names including AUX; only take the ones this
    // session actually streams, so channelCount matches the packet layout.
    const eegLabels = (channelNames as string[]).slice(0, this.eegChannelCount);

    this.initializeStream({
      modality: Modality.EEG,
      processingStage: ProcessingStage.RAW,
      additionalMetadata: {
        samplingRate: EEG_SAMPLING_RATE,
        channelInfo: toChannelInfo(eegLabels, "µV"),
        bufferSize: 12,
      },
    });

    if (this.muse.enablePpg) {
      this.initializeStream({
        modality: Modality.PPG,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: PPG_SAMPLING_RATE,
          channelInfo: toChannelInfo(
            ppgChannelsFor(this.muse.deviceName ?? undefined)
          ),
          bufferSize: 4,
        },
      });
    }
  }

  public async startStream(): Promise<void> {
    await this.muse.start();

    if (!this.isConnected) return;

    const eegChannels = this.eegChannelCount;

    this.streamSubscriptions.push(
      this._eegData
        .pipe(
          // muse-js delivers one electrode per reading; a full frame across
          // all electrodes is what makes an interleaved packet possible.
          bufferCount(eegChannels),
          map((readings) => {
            const { timestamp } = readings[0];
            const out: number[][] = Array.from(
              { length: eegChannels },
              () => []
            );

            for (const { electrode, samples } of readings) {
              if (electrode < eegChannels) out[electrode].push(...samples);
            }

            return { data: out, deviceTime: timestamp };
          })
        )
        .subscribe(({ data, deviceTime }) => {
          this.update({ modality: Modality.EEG }, data, deviceTime);
        })
    );

    if (!this.muse.enablePpg) return;

    this.streamSubscriptions.push(
      this._ppgData
        .pipe(
          bufferCount(3),
          map((readings) => {
            const { timestamp } = readings[0];
            const out: number[][] = [[], [], []];

            for (const { ppgChannel, samples } of readings) {
              if (ppgChannel < 3) out[ppgChannel].push(...samples);
            }

            return { data: out, deviceTime: timestamp };
          })
        )
        .subscribe(({ data, deviceTime }) => {
          this.update({ modality: Modality.PPG }, data, deviceTime);
        })
    );
  }

  public async stopStream(): Promise<void> {
    this.streamSubscriptions.forEach((s) => s.unsubscribe());
    this.streamSubscriptions = [];
    await this.muse.pause();
  }

  public async disconnect(): Promise<void> {
    this.streamSubscriptions.forEach((s) => s.unsubscribe());
    this.streamSubscriptions = [];

    if (this.isConnected) {
      this.muse.disconnect();
    } else {
      console.warn("Muse device is not connected.");
    }
  }
}
