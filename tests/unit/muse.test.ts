/**
 * Muse headbands through the real muse-jsx clients, over a fake Bluetooth stack.
 *
 * The Athena tests replay recorded sessions (see fixtures/README.md) and check
 * the receiver sample for sample against a decoder written here from the
 * protocol description, which shares no code with muse-jsx.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  AnalysisMethod,
  DataPacket,
  Modality,
  MuseReceiver,
  Pipeline,
  PipelineGraph,
} from "../../src";
import { MuseAthenaClient, MuseClient } from "muse-jsx";

const ATHENA_DATA = "273e0013-4c4d-454d-96be-f03bac821358";
const CONTROL = "273e0001-4c4d-454d-96be-f03bac821358";
const CLASSIC_EEG = [3, 4, 5, 6, 7].map(
  (n) => `273e000${n}-4c4d-454d-96be-f03bac821358`
);
const CLASSIC_PPG = ["000f", "0010", "0011"].map(
  (n) => `273e${n}-4c4d-454d-96be-f03bac821358`
);
const CLASSIC_OTHERS = ["9", "a", "b"].map(
  (n) => `273e000${n}-4c4d-454d-96be-f03bac821358`
);
const CLASSIC = [CONTROL, ...CLASSIC_EEG, ...CLASSIC_PPG, ...CLASSIC_OTHERS];
const ATHENA = [CONTROL, ATHENA_DATA];

class FakeCharacteristic extends EventTarget {
  value?: DataView;
  written: string[] = [];

  constructor(
    readonly uuid: string,
    readonly service: { device: EventTarget }
  ) {
    super();
  }

  async startNotifications() {}

  private write(bytes: Uint8Array) {
    // Commands are length-prefixed and newline-terminated.
    this.written.push(Buffer.from(bytes.subarray(1)).toString().trim());
  }
  async writeValue(bytes: Uint8Array) {
    this.write(bytes);
  }
  async writeValueWithoutResponse(bytes: Uint8Array) {
    this.write(bytes);
  }

  notify(bytes: Uint8Array) {
    const copy = bytes.slice();
    this.value = new DataView(copy.buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

/** A headband exposing these characteristics, reachable through the chooser. */
function installHeadband(uuids: string[], name = "Muse-1A2B") {
  const device: any = Object.assign(new EventTarget(), { name });
  const service = {
    device,
    getCharacteristics: async () => chars,
    getCharacteristic: async (uuid: string) => {
      const found = chars.find((c) => c.uuid === uuid);
      if (!found) throw new Error(`No characteristic ${uuid}`);
      return found;
    },
  };
  const chars = uuids.map((uuid) => new FakeCharacteristic(uuid, service));
  const gatt = {
    device,
    connected: false,
    connect: async () => {
      gatt.connected = true;
      return gatt;
    },
    disconnect: () => {
      gatt.connected = false;
      device.dispatchEvent(new Event("gattserverdisconnected"));
    },
    getPrimaryService: async () => service,
  };
  device.gatt = gatt;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { bluetooth: { requestDevice: async () => device } },
  });

  return {
    gatt,
    char: (uuid: string) => chars.find((c) => c.uuid === uuid)!,
  };
}

function capture(preset: string): Uint8Array[] {
  return readFileSync(
    join(__dirname, "fixtures", `muse_athena_${preset}.csv`),
    "utf8"
  )
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => Uint8Array.from(Buffer.from(line.split(",")[2], "hex")));
}

const PAYLOAD_BYTES: Record<number, number> = {
  0x11: 28,
  0x12: 28,
  0x34: 30,
  0x35: 40,
  0x36: 40,
  0x47: 36,
  0x53: 24,
  0x88: 20,
  0x98: 20,
};
const PACKED: Record<number, { bits: number; channels: number; samples: number }> = {
  0x11: { bits: 14, channels: 4, samples: 4 },
  0x12: { bits: 14, channels: 8, samples: 2 },
  0x34: { bits: 20, channels: 4, samples: 3 },
  0x35: { bits: 20, channels: 8, samples: 2 },
  0x36: { bits: 20, channels: 16, samples: 1 },
};

function unpack(bytes: Uint8Array, start: number, count: number, bits: number) {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let value = 0;
    for (let b = 0; b < bits; b++) {
      const at = i * bits + b;
      if ((bytes[start + (at >> 3)] >> (at & 7)) & 1) value += 2 ** b;
    }
    out.push(value);
  }
  return out;
}

/** Sample-major values per sensor, with no scaling applied. */
function decodeReference(notifications: Uint8Array[]) {
  const eeg: number[][] = [];
  const optics: number[][] = [];
  const motion: number[][] = [];
  let statusPackets = 0;
  let unparsedBytes = 0;

  for (const bytes of notifications) {
    let offset = 0;
    while (offset < bytes.length) {
      const end = offset + bytes[offset];
      let i = offset + 9;
      while (i + 5 <= end) {
        const tag = bytes[i];
        const length = PAYLOAD_BYTES[tag];
        if (length === undefined || i + 5 + length > end) break;
        const payload = i + 5;
        const layout = PACKED[tag];
        if (layout) {
          const { bits, channels, samples } = layout;
          const values = unpack(bytes, payload, channels * samples, bits);
          for (let s = 0; s < samples; s++) {
            (bits === 14 ? eeg : optics).push(
              values.slice(s * channels, (s + 1) * channels)
            );
          }
        } else if (tag === 0x88) {
          statusPackets++;
        } else if (tag === 0x47) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + payload, 36);
          for (let s = 0; s < 3; s++) {
            motion.push(
              Array.from({ length: 6 }, (_, c) =>
                view.getInt16((s * 6 + c) * 2, true)
              )
            );
          }
        }
        i = payload + length;
      }
      unparsedBytes += end - i;
      offset = end;
    }
  }
  return { eeg, optics, motion, statusPackets, unparsedBytes };
}

/** Sample-major values of everything published on one stream. */
function samplesOf(packets: DataPacket[], modality: Modality): number[][] {
  const out: number[][] = [];
  for (const packet of packets) {
    if (packet.metadata.modality !== modality) continue;
    const channels = packet.metadata.channelCount!;
    for (let i = 0; i < packet.data.length; i += channels) {
      out.push(Array.from(packet.data.subarray(i, i + channels)));
    }
  }
  return out;
}

function expectClose(actual: number[][], expected: number[][], tolerance: number) {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  actual.forEach((row, r) =>
    row.forEach((value, c) => {
      worst = Math.max(worst, Math.abs(value - expected[r][c]));
    })
  );
  expect(worst).toBeLessThan(tolerance);
}

async function started(receiver: { startStream(): Promise<void> }) {
  const done = receiver.startStream();
  await jest.advanceTimersByTimeAsync(5000);
  await done;
}

/** One graph for both generations, whichever receiver is attached as "muse". */
const heartRateGraph: PipelineGraph = {
  nodes: [
    { id: "ppg", receiver: "muse", stream: Modality.PPG },
    {
      id: "pulse",
      method: AnalysisMethod.CHANNEL_SELECTION,
      parameters: { labels: ["infrared", "LI_RED"] },
    },
    {
      id: "window",
      method: AnalysisMethod.WINDOWING,
      parameters: { size: 10, hop: 1 },
    },
    { id: "bpm", method: AnalysisMethod.HEART_RATE },
  ],
  edges: [
    { from: ["ppg"], to: ["pulse"] },
    { from: ["pulse"], to: ["window"] },
    { from: ["window"], to: ["bpm"] },
  ],
};

function collectRates(receiver: MuseReceiver) {
  const pipeline = new Pipeline(heartRateGraph);
  pipeline.attachReceiver("muse", receiver);
  const rates: number[] = [];
  pipeline.getOutput("bpm").subscribe((p: DataPacket) => rates.push(p.data[0]));
  return { pipeline, rates };
}

describe("muse headbands", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  });

  describe("Athena layout", () => {
    function labels(receiver: MuseReceiver, modality: Modality) {
      return receiver
        .expectedStreams()
        .find((s) => s.modality === modality)
        ?.channelInfo?.map((c) => c.label);
    }

    it("describes itself before connecting", () => {
      const athena = new MuseReceiver({ model: "athena" });

      expect(athena.expectedStreams().map((s) => s.modality)).toEqual([
        Modality.EEG,
        Modality.PPG,
        Modality.ACCELEROMETER,
        Modality.GYROSCOPE,
      ]);
      expect(labels(athena, Modality.EEG)).toEqual(["TP9", "AF7", "AF8", "TP10"]);
      expect(labels(athena, Modality.PPG)).toHaveLength(16);
    });

    it.each([
      ["p21", 4, undefined],
      ["p1035", 4, 4],
      ["p1034", 4, 8],
      ["p1045", 8, 4],
      ["p1044", 8, 8],
      ["p1041", 8, 16],
    ] as const)("%s: %i EEG, %s optical channels", (preset, eeg, optics) => {
      const athena = new MuseReceiver({ model: "athena", preset, enableAUX: true });

      expect(labels(athena, Modality.EEG)).toHaveLength(eeg);
      expect(labels(athena, Modality.PPG)?.length).toBe(optics);
    });
  });

  describe("Athena streaming, detected on connect", () => {
    async function replay(
      preset: "p1041" | "p1035",
      options: { enableAUX?: boolean } = {}
    ) {
      const headband = installHeadband(ATHENA);
      const athena = new MuseReceiver({ preset, ...options });
      const seen: DataPacket[] = [];
      athena.data.subscribe((p) => seen.push(p));

      await athena.connect();
      await started(athena);

      const notifications = capture(preset);
      notifications.forEach((n) => headband.char(ATHENA_DATA).notify(n));

      return { athena, headband, seen, reference: decodeReference(notifications) };
    }

    it("sends the preset, then starts data", async () => {
      const { headband } = await replay("p1035");
      const sent = headband.char(CONTROL).written;

      expect(sent.indexOf("p1035")).toBeGreaterThan(sent.indexOf("h"));
      expect(sent.indexOf("dc001")).toBeGreaterThan(sent.indexOf("p1035"));
    });

    it.each(["p1041", "p1035"] as const)(
      "%s: EEG matches an independent decode, centred on 0 µV",
      async (preset) => {
        const { seen, reference } = await replay(preset);

        const microvolts = reference.eeg.map((row) =>
          row.slice(0, 4).map((raw) => (raw - 8192) * 0.0885)
        );
        expect(reference.eeg.length).toBeGreaterThan(500);
        expectClose(samplesOf(seen, Modality.EEG), microvolts, 0.01);
      }
    );

    it("reads 0x88 status packets as 20 bytes, with sensor data after them", () => {
      // OpenMuse's main branch reads 188 here, which its PR #32 calls a bug. If
      // 20 were wrong the walk would hit a false tag and leave bytes over.
      const { statusPackets, unparsedBytes } = decodeReference(capture("p1041"));

      expect(statusPackets).toBeGreaterThan(0);
      expect(unparsedBytes).toBe(0);
    });

    it("publishes AUX channels only when asked", async () => {
      const { seen, reference } = await replay("p1041", { enableAUX: true });

      const microvolts = reference.eeg.map((row) =>
        row.map((raw) => (raw - 8192) * 0.0885)
      );
      expectClose(samplesOf(seen, Modality.EEG), microvolts, 0.01);
    });

    it.each(["p1041", "p1035"] as const)(
      "%s: optical channels match an independent decode",
      async (preset) => {
        const { seen, reference } = await replay(preset);

        const scaled = reference.optics.map((row) => row.map((raw) => raw / 32768));
        expect(scaled.length).toBeGreaterThan(50);
        expectClose(samplesOf(seen, Modality.PPG), scaled, 1e-3);
      }
    );

    it("splits motion into accelerometer and gyroscope", async () => {
      const { seen, reference } = await replay("p1035");

      expectClose(
        samplesOf(seen, Modality.ACCELEROMETER),
        reference.motion.map((row) => row.slice(0, 3).map((v) => v * 0.00006103515625)),
        1e-4
      );
      expectClose(
        samplesOf(seen, Modality.GYROSCOPE),
        reference.motion.map((row) => row.slice(3).map((v) => v * -0.007476806640625)),
        1e-3
      );
    });

    it("labels the channels that behave like ambient light AMB", async () => {
      const { athena, seen } = await replay("p1041");
      const rows = samplesOf(seen, Modality.PPG);
      const labels = athena.expectedStreams()[1].channelInfo!.map((c) => c.label);

      // Spread around a straight line: the room's light drifts over a recording,
      // and that drift is not what separates the channels.
      const spread = (label: string) => {
        const column = rows.map((row) => row[labels.indexOf(label)]);
        const n = column.length;
        const mean = column.reduce((a, b) => a + b, 0) / n;
        const t = (i: number) => i - (n - 1) / 2;
        const slope =
          column.reduce((a, v, i) => a + t(i) * (v - mean), 0) /
          column.reduce((a, _, i) => a + t(i) ** 2, 0);
        return Math.sqrt(
          column.reduce((a, v, i) => a + (v - mean - slope * t(i)) ** 2, 0) / n
        );
      };

      // Inner LED channels vary with the blood volume under them; ambient light
      // does not.
      for (const led of ["LI_RED", "RI_RED", "LI_730", "RI_730", "LI_850", "RI_850"]) {
        for (const ambient of ["LI_AMB", "RI_AMB", "LO_AMB", "RO_AMB"]) {
          expect(spread(led)).toBeGreaterThan(10 * spread(ambient));
        }
      }
    });

    it("finds the wearer's pulse in LI_RED through the shared graph", async () => {
      const headband = installHeadband(ATHENA);
      const athena = new MuseReceiver();
      const { pipeline, rates } = collectRates(athena);

      await athena.connect();
      pipeline.start();
      await started(athena);
      capture("p1041").forEach((n) => headband.char(ATHENA_DATA).notify(n));

      // The recording's optical channels share a spectral peak at 1.04 Hz.
      expect(rates.length).toBeGreaterThan(5);
      expect(rates[rates.length - 1]).toBeGreaterThan(55);
      expect(rates[rates.length - 1]).toBeLessThan(70);
    });

    it("warns once and drops what the preset does not predict", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const headband = installHeadband(ATHENA);
      const athena = new MuseReceiver({ preset: "p1041" });
      const seen: DataPacket[] = [];
      athena.data.subscribe((p) => seen.push(p));

      await athena.connect();
      await started(athena);
      capture("p1035").forEach((n) => headband.char(ATHENA_DATA).notify(n));

      expect(samplesOf(seen, Modality.EEG)).toHaveLength(0);
      expect(samplesOf(seen, Modality.PPG)).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("reconnects and keeps delivering to an existing subscriber", async () => {
      const headband = installHeadband(ATHENA);
      const athena = new MuseReceiver({ preset: "p1035" });
      const seen: DataPacket[] = [];
      athena.data.subscribe((p) => seen.push(p));
      const [first] = capture("p1035");

      await athena.connect();
      await started(athena);
      headband.char(ATHENA_DATA).notify(first);
      const before = seen.length;
      expect(before).toBeGreaterThan(0);

      await athena.disconnect();
      await athena.connect();
      await started(athena);
      headband.char(ATHENA_DATA).notify(first);

      expect(athena.streams).toContain("Muse-1A2B:eeg:raw");
      expect(seen.length).toBe(before * 2);
    });

    it("stops publishing on stopStream", async () => {
      const headband = installHeadband(ATHENA);
      const athena = new MuseReceiver({ preset: "p1035" });
      const seen: DataPacket[] = [];
      athena.data.subscribe((p) => seen.push(p));
      const [first] = capture("p1035");

      await athena.connect();
      await started(athena);
      const stopping = athena.stopStream();
      await jest.advanceTimersByTimeAsync(100);
      await stopping;
      headband.char(ATHENA_DATA).notify(first);

      expect(seen).toHaveLength(0);
    });
  });

  describe("Muse 2 and classic Muse S", () => {
    it("decodes a classic EEG notification as before", async () => {
      const headband = installHeadband(CLASSIC);
      const muse = new MuseReceiver(false);
      jest.spyOn(muse.muse as MuseClient, "deviceInfo").mockResolvedValue({} as never);
      const seen: DataPacket[] = [];
      muse.data.subscribe((p) => seen.push(p));

      await muse.connect();
      await started(muse);

      // Index, then twelve 12-bit samples. All-zero bytes are the bottom of
      // the range, all-one bytes the top.
      const packet = (fill: number) => {
        const bytes = new Uint8Array(20).fill(fill);
        bytes[0] = 0;
        bytes[1] = 1;
        return bytes;
      };
      headband.char(CLASSIC_EEG[0]).notify(packet(0x00));
      headband.char(CLASSIC_EEG[1]).notify(packet(0xff));
      headband.char(CLASSIC_EEG[2]).notify(packet(0x00));
      headband.char(CLASSIC_EEG[3]).notify(packet(0xff));

      const rows = samplesOf(seen, Modality.EEG);
      expect(rows).toHaveLength(12);
      expect(rows[0]).toEqual([-1000, 999.51171875, -1000, 999.51171875]);
    });

    it("finds a pulse in infrared through the shared graph", async () => {
      const headband = installHeadband(CLASSIC);
      const muse = new MuseReceiver(true);
      jest.spyOn(muse.muse as MuseClient, "deviceInfo").mockResolvedValue({} as never);
      const { pipeline, rates } = collectRates(muse);

      await muse.connect();
      pipeline.start();
      await started(muse);

      // 72 bpm on infrared alone, so reading either other channel finds nothing.
      const SAMPLES_PER_READING = 6;
      const value = (channel: number, sample: number) =>
        channel === 1
          ? Math.round(
              100000 + 20000 * Math.sin((2 * Math.PI * 1.2 * sample) / 64)
            )
          : 100000;

      for (let reading = 0; reading < 200; reading++) {
        CLASSIC_PPG.forEach((uuid, channel) => {
          const bytes = new Uint8Array(20);
          bytes[1] = reading & 0xff;
          bytes[0] = reading >> 8;
          for (let s = 0; s < SAMPLES_PER_READING; s++) {
            const v = value(channel, reading * SAMPLES_PER_READING + s);
            bytes[2 + s * 3] = (v >> 16) & 0xff;
            bytes[3 + s * 3] = (v >> 8) & 0xff;
            bytes[4 + s * 3] = v & 0xff;
          }
          headband.char(uuid).notify(bytes);
        });
      }

      expect(rates.length).toBeGreaterThan(5);
      expect(rates[rates.length - 1]).toBeGreaterThan(69);
      expect(rates[rates.length - 1]).toBeLessThan(75);
    });
  });

  describe("telling the generations apart", () => {
    beforeEach(() => {
      jest.spyOn(console, "error").mockImplementation(() => {});
    });

    it("previews a Muse 2's layout until it knows better", async () => {
      const headband = installHeadband(ATHENA);
      const muse = new MuseReceiver();
      const ppgLabels = () =>
        muse
          .expectedStreams()
          .find((s) => s.modality === Modality.PPG)!
          .channelInfo!.map((c) => c.label);

      expect(ppgLabels()).toEqual(["ambient", "infrared", "red"]);
      expect(muse.deviceName).toBe("Muse");

      await muse.connect();

      expect(headband.gatt.connected).toBe(true);
      expect(ppgLabels()).toHaveLength(16);
      expect(muse.deviceName).toBe("MuseAthena");
      expect(muse.streams).toEqual(
        expect.arrayContaining(["Muse-1A2B:eeg:raw", "Muse-1A2B:ppg:raw"])
      );
    });

    it("moves between generations on one receiver", async () => {
      const muse = new MuseReceiver();

      installHeadband(ATHENA, "Muse-AAAA");
      await muse.connect();
      expect(muse.muse).toBeInstanceOf(MuseAthenaClient);
      expect(muse.deviceID).toBe("Muse-AAAA");
      await muse.disconnect();
      expect(muse.isConnected).toBe(false);

      installHeadband(CLASSIC, "Muse-BBBB");
      jest.spyOn(MuseClient.prototype, "deviceInfo").mockResolvedValue({} as never);
      await muse.connect();
      expect(muse.muse).toBeInstanceOf(MuseClient);
      expect(muse.deviceID).toBe("Muse-BBBB");
      expect(muse.deviceName).toBe("Muse");
      expect(muse.isConnected).toBe(true);
    });

    it("refuses a classic headband when told to expect an Athena", async () => {
      const headband = installHeadband(CLASSIC);
      const muse = new MuseReceiver({ model: "athena" });

      await expect(muse.connect()).rejects.toThrow("is not a Muse S Athena");
      expect(headband.gatt.connected).toBe(false);
      expect(muse.isConnected).toBe(false);
    });

    it("refuses an Athena when told to expect a classic headband", async () => {
      const headband = installHeadband(ATHENA);
      const muse = new MuseReceiver({ model: "classic" });

      await expect(muse.connect()).rejects.toThrow("is a Muse S Athena");
      expect(headband.gatt.connected).toBe(false);
    });

    it("refuses a device that is neither", async () => {
      const headband = installHeadband([CONTROL]);

      await expect(new MuseReceiver().connect()).rejects.toThrow(
        "does not look like any Muse"
      );
      expect(headband.gatt.connected).toBe(false);
    });

    it("explains a browser without Web Bluetooth", async () => {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {},
      });

      await expect(new MuseReceiver().connect()).rejects.toThrow(
        "Web Bluetooth is not available"
      );
    });
  });

  describe("settings", () => {
    const modalities = (muse: MuseReceiver) =>
      muse.expectedStreams().map((s) => s.modality);
    const eegCount = (muse: MuseReceiver) =>
      muse.expectedStreams().find((s) => s.modality === Modality.EEG)!.channelCount;

    it("takes the older positional form", () => {
      expect(modalities(new MuseReceiver(false))).toEqual([Modality.EEG]);
      expect(eegCount(new MuseReceiver(false, true))).toBe(5);
      expect(modalities(new MuseReceiver(true))).toEqual([Modality.EEG, Modality.PPG]);
    });

    it("turns optical channels off on an Athena too", () => {
      const muse = new MuseReceiver({ model: "athena", enablePPG: false });

      expect(modalities(muse)).not.toContain(Modality.PPG);
    });
  });

  describe("reconnecting a classic headband", () => {
    async function connected(muse: MuseReceiver) {
      jest.spyOn(muse.muse as MuseClient, "deviceInfo").mockResolvedValue({} as never);
      await muse.connect();
      await started(muse);
    }

    /** One 12-sample block on every electrode, all at the bottom of the range. */
    function send(headband: ReturnType<typeof installHeadband>, index: number) {
      const bytes = new Uint8Array(20);
      bytes[1] = index;
      CLASSIC_EEG.slice(0, 4).forEach((uuid) => headband.char(uuid).notify(bytes));
    }

    it("keeps streaming after its own disconnect", async () => {
      const headband = installHeadband(CLASSIC);
      const muse = new MuseReceiver(false);
      const seen: DataPacket[] = [];
      muse.data.subscribe((p) => seen.push(p));

      await connected(muse);
      send(headband, 1);

      await muse.disconnect();
      await expect(muse.connect()).resolves.toBeUndefined();
      await started(muse);
      send(headband, 2);

      expect(muse.streams).toEqual(["Muse-1A2B:eeg:raw"]);
      expect(seen).toHaveLength(2);
    });

    it("recovers when the headset drops on its own", async () => {
      const headband = installHeadband(CLASSIC);
      const muse = new MuseReceiver(false);
      const seen: DataPacket[] = [];
      muse.data.subscribe((p) => seen.push(p));

      await connected(muse);
      send(headband, 1);

      // Out of range or powered off: muse-jsx completes its readings without
      // the receiver's own disconnect() having run first.
      headband.gatt.disconnect();
      expect(muse.isConnected).toBe(false);
      await muse.connect();
      await started(muse);
      send(headband, 2);

      expect(seen).toHaveLength(2);
    });
  });
});
