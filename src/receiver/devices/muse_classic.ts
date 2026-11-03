import {
  EEGReading,
  MuseClient,
  MuseDeviceInfo,
  PPGReading,
  channelNames,
} from "muse-jsx";
import { bufferCount, map, Subject, Subscription } from "rxjs";

import { Modality, ProcessingStage } from "../../data_stream.interface";
import { StreamOptions } from "../base_receiver";
import { MuseDriver, MusePublish, toChannelInfo } from "./muse_ble";

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

/**
 * Muse 2 and classic Muse S, where each sensor has its own characteristic and
 * samples are packed in 12 bits. muse-jsx handles connection, subscription and
 * decoding.
 */
export class ClassicMuseDriver implements MuseDriver {
  readonly deviceName = "Muse";

  readonly modalities: Modality[] = [
    Modality.EEG,
    Modality.PPG,
    Modality.ACCELEROMETER,
    Modality.GYROSCOPE,
  ];

  readonly client: MuseClient;
  additionalInfo: MuseDeviceInfo | undefined;

  private _eegData = new Subject<EEGReading>();
  private _ppgData = new Subject<PPGReading>();
  private streamSubscriptions: Subscription[] = [];
  private readingSubscriptions: Subscription[] = [];

  /** 4 electrodes, or 5 when the auxiliary channel is enabled. */
  private eegChannelCount: number;

  constructor(
    options: { enablePPG: boolean; enableAUX: boolean },
    private readonly publish: MusePublish
  ) {
    this.client = new MuseClient();
    this.client.enablePpg = options.enablePPG;
    this.client.enableAux = options.enableAUX;
    this.eegChannelCount = options.enableAUX ? 5 : 4;
  }

  async connect(gatt: unknown): Promise<void> {
    await this.client.connect(gatt as Parameters<MuseClient["connect"]>[0]);
  }

  async ready(): Promise<void> {
    this.additionalInfo = await this.client.deviceInfo();

    // Forward values only: muse-jsx completes its readings on disconnect, and
    // passing that completion on would close these subjects for good.
    // A headset that dropped on its own never ran disconnect(), so clear here.
    this.readingSubscriptions.forEach((s) => s.unsubscribe());
    this.readingSubscriptions = [];
    this.readingSubscriptions.push(
      this.client.eegReadings.subscribe((reading) =>
        this._eegData.next(reading)
      )
    );

    if (this.client.enablePpg) {
      this.readingSubscriptions.push(
        this.client.ppgReadings.subscribe((reading) =>
          this._ppgData.next(reading)
        )
      );
    }
  }

  /**
   * Before connecting the model is unknown, so PPG is laid out as a Muse 2's;
   * `connect()` registers the layout of the headband actually found.
   */
  streams(): StreamOptions[] {
    // muse-jsx publishes five names including AUX; only take the ones this
    // session actually streams, so channelCount matches the packet layout.
    const eegLabels = channelNames.slice(0, this.eegChannelCount);

    const streams: StreamOptions[] = [
      {
        modality: Modality.EEG,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: EEG_SAMPLING_RATE,
          channelInfo: toChannelInfo(eegLabels, "µV"),
          bufferSize: 12,
        },
      },
    ];

    if (this.client.enablePpg) {
      streams.push({
        modality: Modality.PPG,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: PPG_SAMPLING_RATE,
          channelInfo: toChannelInfo(
            ppgChannelsFor(this.client.deviceName ?? undefined)
          ),
          bufferSize: 4,
        },
      });
    }

    return streams;
  }

  async startStream(): Promise<void> {
    await this.client.start();

    if (!this.client.connectionStatus.getValue()) return;

    // Subscribing again without this doubles every packet after a reconnect.
    this.streamSubscriptions.forEach((s) => s.unsubscribe());
    this.streamSubscriptions = [];

    const eegChannels = this.eegChannelCount;

    this.streamSubscriptions.push(
      this._eegData
        .pipe(
          // muse-jsx delivers one electrode per reading; a full frame across
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
          this.publish(Modality.EEG, data, deviceTime);
        })
    );

    if (!this.client.enablePpg) return;

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
          this.publish(Modality.PPG, data, deviceTime);
        })
    );
  }

  async stopStream(): Promise<void> {
    this.streamSubscriptions.forEach((s) => s.unsubscribe());
    this.streamSubscriptions = [];
    await this.client.pause();
  }

  disconnect(): void {
    this.streamSubscriptions.forEach((s) => s.unsubscribe());
    this.streamSubscriptions = [];
    this.readingSubscriptions.forEach((s) => s.unsubscribe());
    this.readingSubscriptions = [];

    if (this.client.connectionStatus.getValue()) {
      this.client.disconnect();
    } else {
      console.warn("Muse device is not connected.");
    }
  }
}
