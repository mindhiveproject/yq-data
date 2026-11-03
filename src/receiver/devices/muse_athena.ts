import {
  AthenaAccGyroSample,
  AthenaOpticalReading,
  AthenaPreset,
  EEGReading,
  MuseAthenaClient,
  MuseDeviceInfo,
} from "muse-jsx";
import { bufferCount, filter, map, Subscription } from "rxjs";

import { Modality, ProcessingStage } from "../../data_stream.interface";
import { StreamOptions } from "../base_receiver";
import { MuseDriver, MusePublish, toChannelInfo } from "./muse_ble";

const EEG_SAMPLING_RATE = 256;
const OPTICS_SAMPLING_RATE = 64;
const MOTION_SAMPLING_RATE = 52;

const MOTION_SAMPLES_PER_BLOCK = 3;

/** Samples in one block of the headband's packets, by channel count. */
const EEG_SAMPLES_PER_BLOCK: Record<number, number> = { 4: 4, 8: 2 };
const OPTICS_SAMPLES_PER_BLOCK: Record<number, number> = { 4: 3, 8: 2, 16: 1 };

/**
 * What each preset streams. The headband never acknowledges a preset, so these
 * come from recorded sessions of each, not from anything it reports.
 */
const PRESET_LAYOUTS: Record<AthenaPreset, { eeg: number; optics: number }> = {
  p21: { eeg: 4, optics: 0 },
  p1034: { eeg: 4, optics: 8 },
  p1035: { eeg: 4, optics: 4 },
  p1041: { eeg: 8, optics: 16 },
  p1042: { eeg: 8, optics: 16 },
  p1044: { eeg: 8, optics: 8 },
  p1045: { eeg: 8, optics: 4 },
  p1046: { eeg: 8, optics: 4 },
  p4129: { eeg: 8, optics: 4 },
};

const EEG_LABELS = [
  "TP9",
  "AF7",
  "AF8",
  "TP10",
  "AUX1",
  "AUX2",
  "AUX3",
  "AUX4",
];
const ELECTRODES_ON_HEAD = 4;

/**
 * Optical channels in the order they arrive. L/R is left/right and I/O the
 * inner/outer detector; 730 and 850 are the LED wavelengths in nm.
 *
 * muse-jsx carries an older 16-channel order. This one follows Interaxon's
 * IXNOptics header as reported in OpenMuse PR #31, and matches a recorded
 * session: the AMB channels are flat while every LED channel shows the pulse.
 */
const OPTICS_LABELS: Record<number, string[]> = {
  4: ["LI_730", "RI_730", "LI_850", "RI_850"],
  8: [
    "LO_730",
    "RO_730",
    "LO_850",
    "RO_850",
    "LI_730",
    "RI_730",
    "LI_850",
    "RI_850",
  ],
  16: [
    "LI_RED",
    "RI_RED",
    "LO_RED",
    "RO_RED",
    "LI_AMB",
    "RI_AMB",
    "LO_AMB",
    "RO_AMB",
    "LI_730",
    "RI_730",
    "LO_730",
    "RO_730",
    "LI_850",
    "RI_850",
    "LO_850",
    "RO_850",
  ],
};

/**
 * muse-jsx scales raw 14-bit samples by 0.0885 µV but leaves them unsigned, so
 * 0 µV arrives as raw midpoint 8192 times that scale.
 */
const EEG_ZERO_OFFSET = 8192 * 0.0885;

/**
 * Muse S Athena (MS-03), which sends every sensor on one characteristic in a
 * format of its own, spoken here by muse-jsx.
 */
export class AthenaMuseDriver implements MuseDriver {
  readonly deviceName = "MuseAthena";
  readonly modalities: Modality[];

  /** Set shortly after connecting, if the headband answers. */
  additionalInfo: MuseDeviceInfo | undefined;

  readonly client = new MuseAthenaClient();

  private readonly preset: AthenaPreset;
  private readonly eegChannels: number;
  private readonly opticsChannels: number;
  private readonly publishedEEGChannels: number;

  private streamSubscriptions: Subscription[] = [];
  private warnedLayout = false;

  constructor(
    options: { enablePPG: boolean; enableAUX: boolean; preset?: AthenaPreset },
    private readonly publish: MusePublish
  ) {
    this.preset = options.preset ?? (options.enablePPG ? "p1041" : "p21");
    const layout = PRESET_LAYOUTS[this.preset];
    this.eegChannels = layout.eeg;
    this.opticsChannels = options.enablePPG ? layout.optics : 0;
    this.publishedEEGChannels = options.enableAUX
      ? layout.eeg
      : ELECTRODES_ON_HEAD;

    this.modalities = [
      Modality.EEG,
      ...(this.opticsChannels > 0 ? [Modality.PPG] : []),
      Modality.ACCELEROMETER,
      Modality.GYROSCOPE,
    ];
  }

  async connect(gatt: unknown): Promise<void> {
    await this.client.connect(gatt as Parameters<MuseAthenaClient["connect"]>[0]);
  }

  async ready(): Promise<void> {
    // Not awaited: muse-jsx listens for the answer only after sending the
    // request, so it can miss it and never resolve.
    this.client
      .deviceInfo()
      .then((info) => (this.additionalInfo = info))
      .catch(() => {});
  }

  streams(): StreamOptions[] {
    const streams: StreamOptions[] = [
      {
        modality: Modality.EEG,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: EEG_SAMPLING_RATE,
          channelInfo: toChannelInfo(
            EEG_LABELS.slice(0, this.publishedEEGChannels),
            "µV"
          ),
          bufferSize: EEG_SAMPLES_PER_BLOCK[this.eegChannels],
        },
      },
    ];

    if (this.opticsChannels > 0) {
      streams.push({
        modality: Modality.PPG,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: OPTICS_SAMPLING_RATE,
          channelInfo: toChannelInfo(OPTICS_LABELS[this.opticsChannels]),
          bufferSize: OPTICS_SAMPLES_PER_BLOCK[this.opticsChannels],
        },
      });
    }

    streams.push(
      {
        modality: Modality.ACCELEROMETER,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: MOTION_SAMPLING_RATE,
          channelInfo: toChannelInfo(["x", "y", "z"], "g"),
          bufferSize: MOTION_SAMPLES_PER_BLOCK,
        },
      },
      {
        modality: Modality.GYROSCOPE,
        processingStage: ProcessingStage.RAW,
        additionalMetadata: {
          samplingRate: MOTION_SAMPLING_RATE,
          channelInfo: toChannelInfo(["x", "y", "z"], "deg/s"),
          bufferSize: MOTION_SAMPLES_PER_BLOCK,
        },
      }
    );

    return streams;
  }

  async startStream(): Promise<void> {
    if (!this.client.connectionStatus.getValue()) return;

    // Subscribing again without this doubles every packet after a reconnect.
    this.unsubscribeStreams();

    // Before start(), which only resolves seconds after data begins to flow.
    this.streamSubscriptions.push(this.subscribeEEG(), this.subscribeMotion());
    if (this.opticsChannels > 0) {
      this.streamSubscriptions.push(this.subscribeOptics());
    }

    await this.client.start(this.preset);
  }

  async stopStream(): Promise<void> {
    this.unsubscribeStreams();
    await this.client.pause();
  }

  disconnect(): void {
    this.unsubscribeStreams();

    if (this.client.connectionStatus.getValue()) {
      this.client.disconnect();
    } else {
      console.warn("Muse device is not connected.");
    }
  }

  private unsubscribeStreams(): void {
    this.streamSubscriptions.forEach((s) => s.unsubscribe());
    this.streamSubscriptions = [];
  }

  private subscribeEEG(): Subscription {
    return this.client.eegReadings
      .pipe(
        // One reading per electrode, every electrode in order for each block.
        bufferCount(this.eegChannels),
        filter((readings) =>
          this.fitsLayout(readings.every((r, i) => r.electrode === i))
        ),
        map((readings: EEGReading[]) => ({
          data: readings
            .slice(0, this.publishedEEGChannels)
            .map((r) => r.samples.map((s) => s - EEG_ZERO_OFFSET)),
          deviceTime: readings[0].timestamp,
        }))
      )
      .subscribe(({ data, deviceTime }) => {
        this.publish(Modality.EEG, data, deviceTime);
      });
  }

  private subscribeOptics(): Subscription {
    const channels = this.opticsChannels;

    return this.client.opticalReadings
      .pipe(
        filter((reading) => this.fitsLayout(reading.samples.length === channels)),
        // One reading per sample here, the other way round from the EEG.
        bufferCount(OPTICS_SAMPLES_PER_BLOCK[channels]),
        map((readings: AthenaOpticalReading[]) => ({
          data: Array.from({ length: channels }, (_, channel) =>
            readings.map((r) => r.samples[channel])
          ),
          deviceTime: readings[0].timestamp,
        }))
      )
      .subscribe(({ data, deviceTime }) => {
        this.publish(Modality.PPG, data, deviceTime);
      });
  }

  private subscribeMotion(): Subscription {
    const axes = (
      readings: AthenaAccGyroSample[],
      sensor: "acc" | "gyro"
    ): number[][] =>
      (["x", "y", "z"] as const).map((axis) =>
        readings.map((r) => r[sensor]?.[axis] ?? 0)
      );

    return this.client.accGyroReadings
      .pipe(bufferCount(MOTION_SAMPLES_PER_BLOCK))
      .subscribe((readings) => {
        const deviceTime = readings[0].timestamp;
        this.publish(Modality.ACCELEROMETER, axes(readings, "acc"), deviceTime);
        this.publish(Modality.GYROSCOPE, axes(readings, "gyro"), deviceTime);
      });
  }

  /**
   * Passes on whether a reading fits the preset, warning once when one does
   * not. A headband on other firmware could send another layout, and packets
   * under the wrong channel labels would look like signal.
   */
  private fitsLayout(fits: boolean): boolean {
    if (!fits && !this.warnedLayout) {
      this.warnedLayout = true;
      console.warn(
        `Muse Athena is not sending what preset ${this.preset} should; dropping what does not fit.`
      );
    }
    return fits;
  }
}
