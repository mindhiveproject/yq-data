/**
 * Performance benchmark: what does yq-data cost on this machine?
 *
 *   npm run bench              everything
 *   npm run bench -- dsp       one section: dsp | chains | pipeline | io
 *
 * The question it answers is not "how fast is each function" but "how much of
 * one CPU core does a real-time session take". Every chain is fed the signal a
 * real device would deliver, in the packet sizes it delivers them, and the
 * wall time spent processing is divided by the seconds of signal that were
 * fed. That ratio is the **load**: 5% means the pipeline keeps up with 95% of
 * a core to spare, 100% means it falls behind live data.
 *
 * Everything here runs in Node on the main thread, as the package does in a
 * page. It does not measure the camera and microphone receivers, whose cost
 * is the vision model rather than this package; the demo reports their frame
 * rate in the browser.
 */
import { performance } from "perf_hooks";
import * as os from "os";

import {
  AnalysisMethod,
  AnyAnalyzer,
  BandPower,
  BaseReceiver,
  DataPacket,
  Filtering,
  HeartRate,
  Modality,
  Pipeline,
  PulseExtraction,
  Recorder,
  StreamIdentifierLiteral,
  StreamMetadata,
  Windowing,
  adaptiveThresholdPeaks,
  butter,
  detrend,
  msptdFast,
  encodeStreamPacket,
  sosfilt,
  sosfiltfilt,
  spectrum,
  decodeStreamMessage,
} from "../src";

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

/** Time per call in µs: median and 95th percentile over repeated batches. */
function time(fn: () => void, budgetMs = 400): { median: number; p95: number } {
  // Warm up so the JIT has seen the function before it is timed.
  const warmStart = performance.now();
  let calls = 0;
  while (performance.now() - warmStart < budgetMs / 4 || calls < 5) {
    fn();
    calls++;
  }

  // Batch fast functions so timer resolution does not dominate.
  const t0 = performance.now();
  fn();
  const single = Math.max(performance.now() - t0, 0.0005);
  const batch = Math.max(1, Math.round(0.5 / single));

  const samples: number[] = [];
  const start = performance.now();
  while (performance.now() - start < budgetMs || samples.length < 15) {
    const s = performance.now();
    for (let i = 0; i < batch; i++) fn();
    samples.push(((performance.now() - s) / batch) * 1000);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)],
    p95: samples[Math.floor(samples.length * 0.95)],
  };
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

function fmtUs(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`;
  if (us >= 10) return `${us.toFixed(0)} µs`;
  return `${us.toFixed(1)} µs`;
}

function heading(title: string, note?: string): void {
  console.log(`\n## ${title}`);
  if (note) console.log(note);
  console.log();
}

/* -------------------------------------------------------------------------- */
/* Signals                                                                     */
/* -------------------------------------------------------------------------- */

/** Pseudo-random but reproducible, so runs compare. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A synthetic pulse train at `bpm`, with noise: shaped like a PPG. */
function pulse(n: number, fs: number, bpm: number, rand = rng(7)): Float32Array {
  const out = new Float32Array(n);
  const f = bpm / 60;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const phase = (t * f) % 1;
    out[i] =
      Math.exp(-Math.pow((phase - 0.2) / 0.08, 2)) +
      0.35 * Math.exp(-Math.pow((phase - 0.55) / 0.1, 2)) +
      0.05 * (rand() - 0.5);
  }
  return out;
}

/** `channels` of 10 Hz alpha plus broadband noise, microvolt-ish. */
function eeg(n: number, fs: number, channels: number, rand = rng(3)): Float32Array {
  const out = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] =
        20 * Math.sin((2 * Math.PI * (9 + c * 0.1) * i) / fs) +
        10 * (rand() - 0.5) +
        500;
    }
  }
  return out;
}

function meta(
  id: string,
  modality: Modality,
  samplingRate: number,
  channels: number,
  extra: Partial<StreamMetadata> = {}
): StreamMetadata {
  return {
    streamID: id,
    modality,
    samplingRate,
    channelCount: channels,
    channelInfo: Array.from({ length: channels }, (_, index) => ({
      index,
      label: `ch${index}`,
    })),
    deviceInfo: { model: "bench", id: "bench" },
    ...extra,
  } as StreamMetadata;
}

/** Cuts a signal into the packets a device would send. */
function packetise(
  data: Float32Array,
  channels: number,
  chunk: number,
  m: StreamMetadata,
  startMs = 0
): DataPacket[] {
  const rate = m.samplingRate!;
  const total = data.length / channels;
  const packets: DataPacket[] = [];
  for (let s = 0; s < total; s += chunk) {
    const end = Math.min(total, s + chunk);
    packets.push({
      streamID: m.streamID as StreamIdentifierLiteral,
      timestamp: startMs + ((end - 1) * 1000) / rate,
      data: data.slice(s * channels, end * channels),
      metadata: m,
    });
  }
  return packets;
}

/* -------------------------------------------------------------------------- */
/* 1. DSP primitives                                                           */
/* -------------------------------------------------------------------------- */

function benchDsp(): void {
  heading(
    "DSP primitives",
    "One call each, on plain arrays. Spectrum is Hamming-windowed PSD."
  );

  console.log(pad("function", 46), lpad("median", 11), lpad("p95", 11));
  const row = (label: string, fn: () => void) => {
    const t = time(fn);
    console.log(pad(label, 46), lpad(fmtUs(t.median), 11), lpad(fmtUs(t.p95), 11));
  };

  for (const n of [256, 512, 1024, 2048, 4096, 8192]) {
    const x = eeg(n, 256, 1);
    row(`spectrum  N=${n}`, () => spectrum(x, { samplingRate: 256, scaling: "psd" }));
  }

  const sos = butter(4, [1, 40], { btype: "bandpass", fs: 256, output: "sos" });
  const chunk = eeg(12, 256, 1);
  const second = eeg(2560, 256, 1);
  row("butter design (order 4 bandpass)", () =>
    butter(4, [1, 40], { btype: "bandpass", fs: 256, output: "sos" })
  );
  row("sosfilt, 12-sample packet, 1 channel", () => {
    const zi = sos.map(() => [0, 0]);
    sosfilt(sos, chunk, zi);
  });
  row("sosfiltfilt, 2560 samples", () => sosfiltfilt(sos, second));

  const ppg10 = pulse(640, 64, 72);
  const ppg10b = pulse(300, 30, 72);
  row("detrend degree 6, 640 samples", () => detrend(ppg10, 6, 64));
  row("msptdFast, 10 s @ 64 Hz", () => msptdFast(ppg10, 64));
  row("msptdFast, 10 s @ 30 Hz", () => msptdFast(ppg10b, 30));
  row("msptdFast, 30 s @ 64 Hz", () => msptdFast(pulse(1920, 64, 72), 64));
  row("adaptiveThresholdPeaks, 10 s @ 64 Hz", () =>
    adaptiveThresholdPeaks(ppg10, { samplingRate: 64, refractoryPeriod: 0.3 })
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Chains, node by node                                                     */
/* -------------------------------------------------------------------------- */

interface Chain {
  title: string;
  /** What the device is, for the reader. */
  device: string;
  seconds: number;
  fs: number;
  channels: number;
  chunk: number;
  modality: Modality;
  signal: (n: number) => Float32Array;
  nodes: Array<[string, AnyAnalyzer]>;
}

/** Feeds packets through nodes in order, timing each node separately. */
function runChain(chain: Chain): void {
  const m = meta(
    `bench:${chain.modality}:raw`,
    chain.modality,
    chain.fs,
    chain.channels,
    { samplesPerChannel: chain.chunk }
  );
  const n = Math.round(chain.seconds * chain.fs);
  const packets = packetise(chain.signal(n), chain.channels, chain.chunk, m);

  const cost = new Map<string, { ms: number; calls: number; out: number }>();
  for (const [name] of chain.nodes) cost.set(name, { ms: 0, calls: 0, out: 0 });

  const t0 = performance.now();
  for (const packet of packets) {
    let batch: DataPacket[] = [packet];
    for (const [name, node] of chain.nodes) {
      const next: DataPacket[] = [];
      const c = cost.get(name)!;
      const s = performance.now();
      for (const p of batch) {
        const r = (node as any).analyze(p) as DataPacket | DataPacket[] | null;
        c.calls++;
        if (r) for (const o of Array.isArray(r) ? r : [r]) next.push(o);
      }
      c.ms += performance.now() - s;
      c.out += next.length;
      batch = next;
      if (batch.length === 0) break;
    }
  }
  const total = performance.now() - t0;

  console.log(`### ${chain.title}`);
  console.log(
    `${chain.device}: ${chain.channels} ch @ ${chain.fs} Hz, ` +
      `${chain.chunk}-sample packets (${(chain.fs / chain.chunk).toFixed(1)}/s), ` +
      `${chain.seconds} s of signal\n`
  );
  console.log(
    pad("node", 22),
    lpad("calls", 8),
    lpad("emitted", 8),
    lpad("per call", 11),
    lpad("per s of signal", 17),
    lpad("load", 8)
  );
  for (const [name, c] of cost) {
    const perCall = (c.ms / Math.max(c.calls, 1)) * 1000;
    const perSecond = c.ms / chain.seconds;
    console.log(
      pad(name, 22),
      lpad(c.calls, 8),
      lpad(c.out, 8),
      lpad(fmtUs(perCall), 11),
      lpad(`${perSecond.toFixed(2)} ms`, 17),
      lpad(`${((perSecond / 1000) * 100).toFixed(2)}%`, 8)
    );
  }
  const load = (total / 1000 / chain.seconds) * 100;
  console.log(
    pad("TOTAL", 22),
    lpad("", 8),
    lpad("", 8),
    lpad("", 11),
    lpad(`${(total / chain.seconds).toFixed(2)} ms`, 17),
    lpad(`${load.toFixed(2)}%`, 8)
  );
  console.log();
}

function benchChains(): void {
  heading(
    "Node-by-node cost per real-time chain",
    "'load' is processing time divided by signal time: the share of one core the\n" +
      "chain needs to keep up with a live device. Nodes are called directly, so the\n" +
      "pipeline's own bookkeeping is not included (see the next section)."
  );

  runChain({
    title: "Muse EEG: bandpass → window → band power",
    device: "Muse",
    seconds: 60,
    fs: 256,
    channels: 4,
    chunk: 12,
    modality: Modality.EEG,
    signal: (n) => eeg(n, 256, 4),
    nodes: [
      ["Filtering", new Filtering({ kind: "bandpass", cutoff: [1, 45] })],
      ["Windowing 2 s / 0.1 s", new Windowing({ size: 2, hop: 0.1 })],
      ["BandPower", new BandPower({})],
    ],
  });

  runChain({
    title: "Muse EEG, per-channel band power, 4 s window",
    device: "Muse",
    seconds: 60,
    fs: 256,
    channels: 4,
    chunk: 12,
    modality: Modality.EEG,
    signal: (n) => eeg(n, 256, 4),
    nodes: [
      ["Filtering", new Filtering({ kind: "bandpass", cutoff: [1, 45] })],
      ["Windowing 4 s / 0.1 s", new Windowing({ size: 4, hop: 0.1 })],
      ["BandPower perChannel", new BandPower({ perChannel: true })],
    ],
  });

  runChain({
    title: "Muse PPG: window → heart rate",
    device: "Muse PPG",
    seconds: 120,
    fs: 64,
    channels: 1,
    chunk: 6,
    modality: Modality.PPG,
    signal: (n) => pulse(n, 64, 72),
    nodes: [
      ["Windowing 10 s / 1 s", new Windowing({ size: 10, hop: 1 })],
      ["HeartRate (MSPTDfast)", new HeartRate({})],
    ],
  });

  runChain({
    title: "Muse PPG with HRV, 30 s window, updated every 0.25 s",
    device: "Muse PPG",
    seconds: 120,
    fs: 64,
    channels: 1,
    chunk: 6,
    modality: Modality.PPG,
    signal: (n) => pulse(n, 64, 72),
    nodes: [
      ["Windowing 30 s / 0.25 s", new Windowing({ size: 30, hop: 0.25 })],
      ["HeartRate + variability", new HeartRate({ includeVariability: true })],
    ],
  });

  runChain({
    title: "Camera rPPG: POS → window → heart rate",
    device: "Webcam via RPPGReceiver",
    seconds: 120,
    fs: 30,
    channels: 3,
    chunk: 1,
    modality: Modality.PPG,
    signal: (n) => {
      const p = pulse(n, 30, 72);
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        out[i * 3] = 180 + 0.4 * p[i];
        out[i * 3 + 1] = 120 + 1.0 * p[i];
        out[i * 3 + 2] = 100 + 0.5 * p[i];
      }
      return out;
    },
    nodes: [
      ["PulseExtraction (POS)", new PulseExtraction({})],
      ["Windowing 10 s / 1 s", new Windowing({ size: 10, hop: 1 })],
      ["HeartRate (MSPTDfast)", new HeartRate({})],
    ],
  });

  runChain({
    title: "High-density EEG over LSL: 32 channels @ 1000 Hz, per-channel band power",
    device: "LSL relay",
    seconds: 30,
    fs: 1000,
    channels: 32,
    chunk: 25,
    modality: Modality.EEG,
    signal: (n) => eeg(n, 1000, 32),
    nodes: [
      ["Filtering", new Filtering({ kind: "bandpass", cutoff: [1, 45] })],
      ["Windowing 2 s / 0.25 s", new Windowing({ size: 2, hop: 0.25 })],
      ["BandPower perChannel", new BandPower({ perChannel: true })],
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* 3. A whole Pipeline                                                         */
/* -------------------------------------------------------------------------- */

class BenchReceiver extends BaseReceiver {
  deviceName = "bench";
  modalities = [Modality.EEG];
  deviceID = "bench";
  private readonly id: StreamIdentifierLiteral;

  constructor(fs: number, channels: number, chunk: number) {
    super();
    this.id = this.initializeStream({
      modality: Modality.EEG,
      additionalMetadata: {
        samplingRate: fs,
        channelCount: channels,
        samplesPerChannel: chunk,
        channelInfo: Array.from({ length: channels }, (_, index) => ({
          index,
          label: `ch${index}`,
        })),
      },
    });
    this.isConnected = true;
  }
  connect(): void {}
  disconnect(): void {}
  startStream(): void {}
  stopStream(): void {}

  push(packet: DataPacket): void {
    this.streamData$.get(this.id)!.next({
      ...packet,
      streamID: this.id,
      metadata: this.streamMeta.get(this.id)!,
    });
  }
}

function benchPipeline(): void {
  heading(
    "Whole Pipeline, end to end",
    "The Muse EEG graph run through `Pipeline`, so the evaluator, the packet\n" +
      "metadata and the RxJS fan-out are in the measurement. Compare 'load' with\n" +
      "the direct chain above to see what the pipeline adds."
  );

  const seconds = 60;
  const fs = 256;
  const channels = 4;
  const chunk = 12;

  const run = (label: string, outputs: string[], graph: any) => {
    const receiver = new BenchReceiver(fs, channels, chunk);
    const pipeline = new Pipeline(graph, { onError: (e) => { throw e; } });
    pipeline.attachReceiver("muse", receiver);
    let emitted = 0;
    for (const id of outputs) pipeline.getOutput(id).subscribe(() => emitted++);
    pipeline.start();

    const m = meta("bench:eeg:raw", Modality.EEG, fs, channels, { samplesPerChannel: chunk });
    const packets = packetise(eeg(seconds * fs, fs, channels), channels, chunk, m);

    // Per-packet times, because a live display stutters on the slowest packet,
    // not on the average one.
    const each: number[] = [];
    const t0 = performance.now();
    for (const p of packets) {
      const s = performance.now();
      receiver.push(p);
      each.push(performance.now() - s);
    }
    const ms = performance.now() - t0;
    pipeline.destroy();

    each.sort((a, b) => a - b);
    const at = (q: number) => each[Math.min(each.length - 1, Math.floor(each.length * q))];

    console.log(
      pad(label, 52),
      lpad(`${(ms / seconds).toFixed(2)} ms/s`, 11),
      lpad(`${((ms / 1000 / seconds) * 100).toFixed(2)}%`, 8),
      lpad(`${at(0.5).toFixed(3)}`, 9),
      lpad(`${at(0.99).toFixed(3)}`, 9),
      lpad(`${each[each.length - 1].toFixed(3)}`, 9)
    );
  };

  console.log(
    pad("graph", 52),
    lpad("cost", 11),
    lpad("load", 8),
    lpad("p50 ms", 9),
    lpad("p99 ms", 9),
    lpad("max ms", 9)
  );

  const base = [
    { id: "eeg", receiver: "muse", stream: Modality.EEG },
    { id: "clean", method: AnalysisMethod.FILTERING, parameters: { kind: "bandpass", cutoff: [1, 45] } },
    { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
    { id: "bands", method: AnalysisMethod.BAND_POWER },
  ];
  const chainEdges = [
    { from: ["eeg"], to: ["clean"] },
    { from: ["clean"], to: ["window"] },
    { from: ["window"], to: ["bands"] },
  ];

  run("eeg → filter → window → band power", ["bands"], { nodes: base, edges: chainEdges });

  run("same, no analysis (source only)", ["eeg"], {
    nodes: [base[0]],
    edges: [],
  });

  run(
    "same + RMS and statistics fanned off the window",
    ["bands", "rms", "stats"],
    {
      nodes: [
        ...base,
        { id: "rms", method: AnalysisMethod.RMS },
        { id: "stats", method: AnalysisMethod.STATISTICAL_FEATURES },
      ],
      edges: [
        ...chainEdges,
        { from: ["window"], to: ["rms"] },
        { from: ["window"], to: ["stats"] },
      ],
    }
  );

  run("four independent band-power branches (4 × cost)", ["b0", "b1", "b2", "b3"], {
    nodes: [
      base[0],
      ...[0, 1, 2, 3].flatMap((i) => [
        { id: `w${i}`, method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
        { id: `b${i}`, method: AnalysisMethod.BAND_POWER },
      ]),
    ],
    edges: [0, 1, 2, 3].flatMap((i) => [
      { from: ["eeg"], to: [`w${i}`] },
      { from: [`w${i}`], to: [`b${i}`] },
    ]),
  });
}

/* -------------------------------------------------------------------------- */
/* 3b. Long sessions and graph editing                                         */
/* -------------------------------------------------------------------------- */

function heapUsedMB(): number {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

function benchSoak(): void {
  heading(
    "Long session",
    "The Muse graph (filter → window → band power) with the output subscribed to,\n" +
      "run for a simulated hour. Heap is read after a forced collection, so growth\n" +
      "here is retained memory, not garbage waiting to be collected."
  );
  if (!global.gc) {
    console.log("(skipped: run with --expose-gc)");
    return;
  }

  const fs = 256;
  const channels = 4;
  const chunk = 12;
  const receiver = new BenchReceiver(fs, channels, chunk);
  const pipeline = new Pipeline({
    nodes: [
      { id: "eeg", receiver: "muse", stream: Modality.EEG },
      { id: "clean", method: AnalysisMethod.FILTERING, parameters: { kind: "bandpass", cutoff: [1, 45] } },
      { id: "window", method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
      { id: "bands", method: AnalysisMethod.BAND_POWER },
    ],
    edges: [
      { from: ["eeg"], to: ["clean"] },
      { from: ["clean"], to: ["window"] },
      { from: ["window"], to: ["bands"] },
    ],
  });
  pipeline.attachReceiver("muse", receiver);
  let last = 0;
  pipeline.getOutput("bands").subscribe((p) => (last = p.data[0]));
  pipeline.start();

  const m = meta("bench:eeg:raw", Modality.EEG, fs, channels, { samplesPerChannel: chunk });
  // One minute of signal, replayed with advancing timestamps.
  const minute = packetise(eeg(60 * fs, fs, channels), channels, chunk, m);

  const start = heapUsedMB();
  console.log(pad("simulated", 14), lpad("heap MB", 10), lpad("Δ vs start", 12), lpad("wall s", 9));
  const wall0 = performance.now();
  for (let min = 1; min <= 60; min++) {
    const offset = (min - 1) * 60_000;
    for (const p of minute) receiver.push({ ...p, timestamp: p.timestamp + offset });
    if (min === 1 || min % 15 === 0) {
      const h = heapUsedMB();
      console.log(
        pad(`${min} min`, 14),
        lpad(h.toFixed(1), 10),
        lpad(`${(h - start >= 0 ? "+" : "") + (h - start).toFixed(1)} MB`, 12),
        lpad(((performance.now() - wall0) / 1000).toFixed(1), 9)
      );
    }
  }
  pipeline.destroy();
  void last;
}

/** What a node editor pays: building, checking and describing a graph. */
function benchEditor(): void {
  heading(
    "Graph editing",
    "A node editor calls these on every edit. Each branch is a source, a filter,\n" +
      "a window and a band power node; branches are joined pairwise into\n" +
      "Correlation nodes."
  );

  const build = (branches: number) => {
    const nodes: any[] = [];
    const edges: any[] = [];
    for (let i = 0; i < branches; i++) {
      nodes.push(
        { id: `s${i}`, receiver: `r${i}`, stream: Modality.EEG },
        { id: `f${i}`, method: AnalysisMethod.FILTERING, parameters: { kind: "bandpass", cutoff: [1, 45] } },
        { id: `w${i}`, method: AnalysisMethod.WINDOWING, parameters: { size: 2, hop: 0.1 } },
        { id: `b${i}`, method: AnalysisMethod.BAND_POWER, parameters: { perChannel: true } }
      );
      edges.push(
        { from: [`s${i}`], to: [`f${i}`] },
        { from: [`f${i}`], to: [`w${i}`] },
        { from: [`w${i}`], to: [`b${i}`] }
      );
    }
    for (let i = 0; i + 1 < branches; i += 2) {
      nodes.push({ id: `c${i}`, method: AnalysisMethod.CONNECTIVITY });
      edges.push(
        { from: [`w${i}`], to: [`c${i}`, "a"] },
        { from: [`w${i + 1}`], to: [`c${i}`, "b"] }
      );
    }
    return { nodes, edges };
  };

  console.log(pad("graph", 30), lpad("construct", 11), lpad("issues()", 11), lpad("describe()", 11));
  for (const branches of [1, 4, 8]) {
    const graph = build(branches);
    const receivers = Array.from({ length: branches }, () => new BenchReceiver(256, 4, 12));
    const made = time(() => void new Pipeline(graph as any), 200);

    const pipeline = new Pipeline(graph as any);
    receivers.forEach((r, i) => pipeline.attachReceiver(`r${i}`, r));
    const issues = time(() => void pipeline.issues(), 200);
    const describe = time(() => void pipeline.describe(), 200);
    console.log(
      pad(`${branches} branch${branches > 1 ? "es" : ""}, ${graph.nodes.length} nodes`, 30),
      lpad(fmtUs(made.median), 11),
      lpad(fmtUs(issues.median), 11),
      lpad(fmtUs(describe.median), 11)
    );
    pipeline.destroy();
  }
}

/** A long window is the one place Windowing's buffer could hurt. */
function benchWindowing(): void {
  heading(
    "Windowing at scale",
    "Per-packet cost of the buffering node alone as the window grows."
  );
  console.log(pad("window", 40), lpad("per packet", 12), lpad("per window", 12));
  const cases: Array<[string, number, number, number, number, number]> = [
    // label, seconds, hop, fs, channels, chunk
    ["2 s, 4 ch @ 256 Hz", 2, 0.1, 256, 4, 12],
    ["30 s, 4 ch @ 256 Hz", 30, 0.1, 256, 4, 12],
    ["2 s, 32 ch @ 1 kHz", 2, 0.25, 1000, 32, 25],
    ["10 s, 32 ch @ 1 kHz", 10, 0.1, 1000, 32, 25],
    ["60 s, 8 ch @ 500 Hz, hop 1 s", 60, 1, 500, 8, 25],
  ];
  for (const [label, size, hop, fs, channels, chunk] of cases) {
    const node = new Windowing({ size, hop });
    const m = meta("bench:eeg:raw", Modality.EEG, fs, channels, { samplesPerChannel: chunk });
    const packets = packetise(eeg(Math.round((size + 20) * fs), fs, channels), channels, chunk, m);
    let windows = 0;
    const t0 = performance.now();
    for (const p of packets) if (node.analyze(p)) windows++;
    const ms = performance.now() - t0;
    console.log(
      pad(label, 40),
      lpad(fmtUs((ms / packets.length) * 1000), 12),
      lpad(windows ? fmtUs((ms / windows) * 1000) : "-", 12)
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Wire and recording                                                       */
/* -------------------------------------------------------------------------- */

/** JS heap plus typed-array backing stores, which the heap figure leaves out. */
function heapMB(): number {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return (m.heapUsed + m.arrayBuffers) / 1048576;
}

async function benchIo(): Promise<void> {
  heading("yq-stream (WebSocketTransport, JSON)");

  const decode = decodeStreamMessage;
  const m = meta("bench:eeg:raw", Modality.EEG, 256, 4, { samplesPerChannel: 12 });
  const packet = packetise(eeg(12, 256, 4), 4, 12, m)[0];
  const bigM = meta("bench:eeg:windowed", Modality.EEG, 256, 4, { samplesPerChannel: 512 });
  const big = packetise(eeg(512, 256, 4), 4, 512, bigM)[0];

  console.log(pad("message", 46), lpad("encode", 11), lpad("decode", 11), lpad("size", 10));
  for (const [label, p] of [
    ["raw EEG packet, 12 × 4", packet],
    ["windowed EEG packet, 512 × 4", big],
  ] as const) {
    const wire = encodeStreamPacket(p);
    const text = JSON.stringify(wire);
    const enc = time(() => JSON.stringify(encodeStreamPacket(p)));
    const dec = time(() => decode(JSON.parse(text)));
    console.log(
      pad(label, 46),
      lpad(fmtUs(enc.median), 11),
      lpad(fmtUs(dec.median), 11),
      lpad(`${(text.length / 1024).toFixed(1)} KB`, 10)
    );
  }
  const perSecond = (256 / 12) * JSON.stringify(encodeStreamPacket(packet)).length;
  console.log(
    `\nA Muse's raw EEG over this wire: ${(perSecond / 1024).toFixed(1)} KB/s ` +
      `(${((perSecond * 8) / 1000).toFixed(0)} kbit/s)`
  );

  heading(
    "Recorder",
    "Capture cost per packet, memory held while recording, and export time."
  );

  const rm = meta("bench:eeg:raw", Modality.EEG, 256, 4, { samplesPerChannel: 12 });
  const minutes = 60;
  const packets = packetise(eeg(minutes * 60 * 256, 256, 4), 4, 12, rm);

  const recorder = new Recorder();
  const src = new (require("rxjs").Subject)();
  recorder.addSource(src);
  recorder.start();

  const t0 = performance.now();
  for (const p of packets) src.next(p);
  const captureMs = performance.now() - t0;
  recorder.stop();

  // Computed from the storage layout, not read from the process: Node's memory
  // counters lag typed-array allocation by enough to misread a run this small.
  // A sample costs 4 bytes a channel as float32, plus an 8-byte timestamp.
  const samples = minutes * 60 * 256;
  const bytesPerHour = (256 * 3600 * (4 * 4 + 8)) / 1048576;

  console.log(
    `capture: ${((captureMs / packets.length) * 1000).toFixed(1)} µs/packet, ` +
      `${(captureMs / (minutes * 60)).toFixed(2)} ms per second of signal`
  );
  console.log(
    `memory:  ${((samples * (4 * 4 + 8)) / 1048576).toFixed(1)} MB held for ${minutes} min of ` +
      `Muse EEG, computed (${bytesPerHour.toFixed(0)} MB/hour); ` +
      `32 ch at 1 kHz is ${((1000 * 3600 * (32 * 4 + 8)) / 1048576).toFixed(0)} MB/hour`
  );

  try {
    const e0 = performance.now();
    const blob = await recorder.export();
    console.log(
      `export:  ${((performance.now() - e0) / 1000).toFixed(2)} s to build a ` +
        `${(blob.size / 1048576).toFixed(1)} MB zip`
    );
  } catch (e) {
    console.log(`export:  skipped (${(e as Error).message})`);
  }
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const only = process.argv[2];
  const cpus = os.cpus();
  console.log("# yq-data benchmark");
  console.log(
    `${cpus[0]?.model ?? "unknown CPU"} · ${cpus.length} cores · ` +
      `node ${process.version} · ${os.platform()} ${os.arch()}`
  );

  if (!only || only === "dsp") benchDsp();
  if (!only || only === "chains") benchChains();
  if (!only || only === "pipeline") {
    benchPipeline();
    benchSoak();
    benchEditor();
    benchWindowing();
  }
  if (!only || only === "io") await benchIo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
