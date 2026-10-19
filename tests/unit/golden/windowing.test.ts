/**
 * Golden-value tests: the Windowing node against plain sliding-window framing.
 *
 * Reference: frame k is samples [k*hop, k*hop + size) of the whole record --
 * what `numpy.lib.stride_tricks.sliding_window_view(x, size)[::hop]` (or
 * `librosa.util.frame`) returns. Simple enough to compute here, so there is no
 * Python fixture; the signals still come from `_inputs.json`.
 *
 * `[divergence]` tests use `divergence` (= `it.failing`); see README.md.
 */
import "./allclose";
import { Windowing } from "../../../src";
import { divergence, inputs, packetStream, recorder } from "./harness";

const rec = recorder("windowing");
afterAll(() => rec.flush());

interface Config {
  signal: string;
  size: number;
  hop: number;
  packet: number;
  why: string;
}

/** Streams a signal through a Windowing node and collects every window. */
function stream({ signal, size, hop, packet }: Config) {
  const node = new Windowing({ size, hop, unit: "samples" });
  const windows: number[][] = [];
  for (const p of packetStream(signal, packet)) {
    const out = node.analyze(p);
    if (out) windows.push(Array.from(out.data));
  }
  return windows;
}

const frame = (signal: string, k: number, size: number, hop: number) =>
  inputs[signal].channels[0].slice(k * hop, k * hop + size).map(Math.fround);

const frameCount = (signal: string, size: number, hop: number) =>
  Math.floor((inputs[signal].channels[0].length - size) / hop) + 1;

const configs: Config[] = [
  { signal: "white_noise_unit", size: 256, hop: 256, packet: 12, why: "no overlap, Muse packets" },
  { signal: "white_noise_unit", size: 256, hop: 64, packet: 12, why: "75% overlap, Muse packets" },
  { signal: "white_noise_unit", size: 512, hop: 128, packet: 128, why: "hop = packet" },
  { signal: "eeg_dc_drift_30s", size: 512, hop: 10, packet: 12, why: "2 s window, 0.04 s hop, Muse" },
];

describe("golden: Windowing vs sliding-window framing", () => {
  it.each(configs)("$why: each emitted window is the next frame, in order", (c) => {
    const windows = stream(c);
    windows.forEach((w, k) => expect(w).toBeAllClose(frame(c.signal, k, c.size, c.hop), { rtol: 0 }));
  });

  const hopAtLeastPacket = configs.filter((c) => c.hop >= c.packet);
  it.each(hopAtLeastPacket)("$why: emits every frame when hop >= packet size", (c) => {
    expect(stream(c).length).toBe(frameCount(c.signal, c.size, c.hop));
  });

  // analyze() returns at most one packet per input packet, so when a packet
  // carries more than one hop of new samples the surplus frames queue in the
  // buffer and are never caught up: latency grows by (packet - hop) samples
  // per packet. Muse at 256 Hz with a 0.04 s hop falls ~10 s behind per
  // minute. Divergence D9.
  const hopBelowPacket = configs.filter((c) => c.hop < c.packet);
  divergence.each(hopBelowPacket)(
    "[divergence] $why: emits every frame when hop < packet size",
    (c) => {
      const emitted = stream(c).length;
      const expected = frameCount(c.signal, c.size, c.hop);
      const fs = inputs[c.signal].fs;
      rec.record(`frames:${c.signal}:${c.size}:${c.hop}:${c.packet}`, {
        emitted,
        expected,
        lagSecondsAtEnd: ((expected - emitted) * c.hop) / fs,
      });
      expect(emitted).toBe(expected);
    }
  );
});

describe("golden: Windowing lag over time", () => {
  it("never emits more frames than a plain sliding window has", () => {
    // Muse packets into a 2 s window with a 0.04 s hop: the frames the node
    // has emitted so far against the frames a plain sliding window would have.
    const c: Config = { signal: "eeg_dc_drift_30s", size: 512, hop: 10, packet: 12, why: "" };
    const fs = inputs[c.signal].fs;
    const node = new Windowing({ size: c.size, hop: c.hop, unit: "samples" });
    const time: number[] = [];
    const lag: number[] = [];
    let emitted = 0;
    let received = 0;
    for (const p of packetStream(c.signal, c.packet)) {
      if (node.analyze(p)) emitted++;
      received += p.data.length / inputs[c.signal].channels.length;
      const expected = Math.max(0, Math.floor((received - c.size) / c.hop) + 1);
      time.push(received / fs);
      lag.push(((expected - emitted) * c.hop) / fs);
    }
    rec.compare({
      id: "windowing:lag",
      group: "Windowing",
      title: "Lag behind real time, 2 s window with a 0.04 s hop on 12-sample Muse packets",
      note: "Seconds of data waiting in the queue: frames a sliding window would have produced, minus frames the node has emitted.",
      kind: "line",
      x: time,
      series: [
        { name: "Ideal", role: "reference", values: lag.map(() => 0) },
        { name: "Package", role: "package", values: lag },
      ],
      xLabel: "Streaming time (s)",
      yLabel: "Lag (s)",
      unit: " s",
      expect: "diverges",
    });
    expect(Math.min(...lag)).toBeGreaterThanOrEqual(0);
  });
});
