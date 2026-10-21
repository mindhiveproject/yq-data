/**
 * Golden-value tests: the Windowing node against plain sliding-window framing.
 *
 * Reference: frame k is samples [k*hop, k*hop + size) of the whole record --
 * what `numpy.lib.stride_tricks.sliding_window_view(x, size)[::hop]` (or
 * `librosa.util.frame`) returns. Simple enough to compute here, so there is no
 * Python fixture; the signals still come from `_inputs.json`.
 *
 * Both delivery modes are held to it:
 * - `frames: "all"` emits every frame, in order -- offline framing, streamed.
 * - `frames: "latest"` (the default) emits, after each packet, the newest
 *   frame that packet completed, and skips older ones. It never falls more
 *   than one hop behind the input, and when the hop is at least a packet it
 *   emits exactly what `"all"` does.
 */
import "./allclose";
import { DataPacket, Windowing } from "../../../src";
import { inputs, packetFor } from "./harness";


type Frames = "latest" | "all";

interface Config {
  signal: string;
  size: number;
  hop: number;
  packet: number;
  why: string;
}

interface Emitted {
  /** Window contents, first channel. */
  data: number[];
  /** Samples per channel received when the window was emitted. */
  received: number;
  timestamp: number;
  packetRate: number;
}

/**
 * The signal cut into device-sized packets, each stamped in milliseconds with
 * the time of its last sample, as `DataPacket.timestamp` is defined.
 */
function devicePackets(signal: string, packet: number): DataPacket[] {
  const { fs, channels } = inputs[signal];
  const n = channels[0].length;
  const out: DataPacket[] = [];
  for (let start = 0; start < n; start += packet) {
    const stop = Math.min(n, start + packet);
    out.push({ ...packetFor(signal, { samples: [start, stop] }), timestamp: ((stop - 1) / fs) * 1000 });
  }
  return out;
}

/** Streams a signal through a Windowing node and collects every window. */
function stream({ signal, size, hop, packet }: Config, frames: Frames): Emitted[] {
  const node = new Windowing({ size, hop, unit: "samples", frames });
  const channels = inputs[signal].channels.length;
  const out: Emitted[] = [];
  let received = 0;
  for (const p of devicePackets(signal, packet)) {
    received += p.data.length / channels;
    const result = node.analyze(p);
    for (const w of result ? [result].flat() : []) {
      out.push({
        data: Array.from({ length: size }, (_, i) => w.data[i * channels]),
        received,
        timestamp: w.timestamp,
        packetRate: w.metadata.additionalMetadata?.packetRate,
      });
    }
  }
  return out;
}

const frame = (signal: string, k: number, size: number, hop: number) =>
  inputs[signal].channels[0].slice(k * hop, k * hop + size).map(Math.fround);

const frameCount = (signal: string, size: number, hop: number) =>
  Math.floor((inputs[signal].channels[0].length - size) / hop) + 1;

/** Index of the newest frame complete after `received` samples. */
const newestFrame = (received: number, size: number, hop: number) =>
  Math.floor((received - size) / hop);

/** Time in ms of the last sample of frame k. */
const frameEnd = (signal: string, k: number, size: number, hop: number) =>
  ((k * hop + size - 1) / inputs[signal].fs) * 1000;

const configs: Config[] = [
  { signal: "white_noise_unit", size: 256, hop: 256, packet: 12, why: "no overlap, Muse packets" },
  { signal: "white_noise_unit", size: 256, hop: 64, packet: 12, why: "75% overlap, Muse packets" },
  { signal: "white_noise_unit", size: 512, hop: 128, packet: 128, why: "hop = packet" },
  { signal: "eeg_dc_drift_30s", size: 512, hop: 10, packet: 12, why: "2 s window, 0.04 s hop, Muse" },
  { signal: "eeg_dc_drift_30s", size: 512, hop: 1, packet: 12, why: "one-sample hop, Muse" },
];

describe('golden: Windowing frames: "all" vs sliding-window framing', () => {
  it.each(configs)("$why: emits every frame, in order", (c) => {
    const windows = stream(c, "all");
    expect(windows.length).toBe(frameCount(c.signal, c.size, c.hop));
    windows.forEach((w, k) => expect(w.data).toBeAllClose(frame(c.signal, k, c.size, c.hop), { rtol: 0 }));
  });

  it.each(configs)("$why: each window is stamped with its last sample's time", (c) => {
    const windows = stream(c, "all");
    expect(windows.map((w) => w.timestamp)).toBeAllClose(
      windows.map((_, k) => frameEnd(c.signal, k, c.size, c.hop)),
      { rtol: 1e-12, atol: 1e-9 }
    );
  });

  it.each(configs)("$why: packetRate is rate / hop", (c) => {
    for (const w of stream(c, "all")) expect(w.packetRate).toBeCloseTo(inputs[c.signal].fs / c.hop, 9);
  });
});

describe('golden: Windowing frames: "latest" (default) vs sliding-window framing', () => {
  it.each(configs)("$why: each window is the newest frame complete at that point", (c) => {
    for (const w of stream(c, "latest")) {
      const k = newestFrame(w.received, c.size, c.hop);
      expect(w.data).toBeAllClose(frame(c.signal, k, c.size, c.hop), { rtol: 0 });
    }
  });

  it.each(configs)("$why: never falls a hop behind the input", (c) => {
    const windows = stream(c, "latest");
    // A window per packet once the buffer fills, or per hop when the hop is longer.
    const packetsAfterFill = Math.ceil(
      (inputs[c.signal].channels[0].length - c.size + 1) / Math.max(c.hop, c.packet)
    );
    expect(windows.length).toBeGreaterThanOrEqual(packetsAfterFill - 1);
    for (const w of windows) {
      const k = newestFrame(w.received, c.size, c.hop);
      expect(w.received - (k * c.hop + c.size)).toBeLessThan(c.hop);
    }
  });

  it.each(configs)("$why: each window is stamped with its last sample's time", (c) => {
    for (const w of stream(c, "latest")) {
      const k = newestFrame(w.received, c.size, c.hop);
      expect([w.timestamp]).toBeAllClose([frameEnd(c.signal, k, c.size, c.hop)], { rtol: 1e-12, atol: 1e-9 });
    }
  });

  it.each(configs)("$why: packetRate is the rate windows actually arrive at", (c) => {
    const windows = stream(c, "latest");
    const fs = inputs[c.signal].fs;
    const span = (windows[windows.length - 1].received - windows[0].received) / fs;
    const observed = (windows.length - 1) / span;
    expect([windows[windows.length - 1].packetRate]).toBeAllClose([observed], { rtol: 0.02 });
    expect(windows[0].packetRate).toBeCloseTo(fs / Math.max(c.hop, c.packet), 9);
  });

  const hopAtLeastPacket = configs.filter((c) => c.hop >= c.packet);
  it.each(hopAtLeastPacket)('$why: same windows as "all" when hop >= packet size', (c) => {
    const latest = stream(c, "latest");
    const all = stream(c, "all");
    expect(latest.length).toBe(all.length);
    latest.forEach((w, k) => expect(w.data).toEqual(all[k].data));
  });
});

describe("golden: Windowing lag over time", () => {
  it("neither mode falls behind real time", () => {
    // Muse packets into a 2 s window with a 0.04 s hop: how old the newest
    // window a consumer has seen is, against the newest sample received.
    const c = configs.find((k) => k.hop === 10)!;
    const fs = inputs[c.signal].fs;
    const lagOf = (frames: Frames) => {
      const time: number[] = [];
      const lag: number[] = [];
      for (const w of stream(c, frames)) {
        const k = newestFrame(w.received, c.size, c.hop);
        const shown = Math.round(((w.timestamp / 1000) * fs - (c.size - 1)) / c.hop);
        time.push(w.received / fs);
        lag.push(((k - shown) * c.hop + (w.received - (k * c.hop + c.size))) / fs);
      }
      return { time, lag };
    };
    const latest = lagOf("latest");
    const all = lagOf("all");
    const hop = c.hop / fs;
    expect(Math.max(...latest.lag)).toBeLessThan(hop);
    // An "all" burst's older window is one hop older than the newest.
    expect(Math.max(...all.lag)).toBeLessThan(2 * hop);
  });
});
