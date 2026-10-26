/**
 * Exporting a recording and reading it back.
 *
 * The CSV is written a few thousand rows at a time so that no single string
 * ever holds a whole file (a long, high-channel recording passes V8's string
 * limit). The thing to guard is the seam between chunks: a lost or doubled
 * newline there would corrupt a recording without any error, so these tests
 * record well past one chunk and check the rows either side of every seam.
 */
import { Subject } from "rxjs";
import JSZip from "jszip";
import {
  DataPacket,
  FileReplayReceiver,
  Modality,
  Recorder,
  StreamIdentifierLiteral,
  StreamMetadata,
} from "../../src";

const ID = "rec:eeg:raw" as StreamIdentifierLiteral;

function meta(over: Partial<StreamMetadata> = {}): StreamMetadata {
  return {
    streamID: ID,
    modality: Modality.EEG,
    samplingRate: 100,
    channelCount: 3,
    channelInfo: [
      { index: 0, label: "a" },
      { index: 1, label: "b" },
      { index: 2, label: "c" },
    ],
    ...over,
  };
}

/** Sample `i`, channel `c` is `i + c / 4`: exact in float32 and easy to check by eye. */
function value(i: number, c: number): number {
  return i + c / 4;
}

function packets(total: number, perPacket: number, m: StreamMetadata): DataPacket[] {
  const out: DataPacket[] = [];
  for (let s = 0; s < total; s += perPacket) {
    const n = Math.min(perPacket, total - s);
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = value(s + i, c);
    out.push({ streamID: ID, timestamp: 1_000_000 + s * 10, data, metadata: m });
  }
  return out;
}

async function csvOf(blob: Blob, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const file = Object.keys(zip.files).find((p) => p.endsWith(name));
  if (!file) throw new Error(`no ${name} in ${Object.keys(zip.files).join(", ")}`);
  return zip.files[file].async("string");
}

async function record(all: DataPacket[]): Promise<Blob> {
  const source = new Subject<DataPacket>();
  const recorder = new Recorder();
  recorder.addSource(source);
  recorder.start();
  all.forEach((p) => source.next(p));
  recorder.stop();
  return recorder.export();
}

describe("Recorder export", () => {
  // 4096 rows per chunk: this is a little over two and a half chunks.
  const TOTAL = 10_000;
  let csv: string;
  let lines: string[];

  beforeAll(async () => {
    csv = await csvOf(await record(packets(TOTAL, 25, meta())), "rec_eeg_raw.csv");
    lines = csv.split("\n");
  });

  it("writes one row per sample under one header", () => {
    expect(lines).toHaveLength(TOTAL + 1);
    expect(lines[0]).toBe("timestamp,a,b,c");
  });

  it("does not end in a newline, or leave a blank line anywhere", () => {
    expect(csv.endsWith("\n")).toBe(false);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });

  it("keeps every row whole across the chunk seams", () => {
    // Rows 4095/4096 and 8191/8192 straddle the seams, plus the ends.
    for (const i of [0, 1, 4094, 4095, 4096, 4097, 8190, 8191, 8192, 8193, TOTAL - 1]) {
      const cells = lines[i + 1].split(",").map(Number);
      expect(cells).toHaveLength(4);
      expect(cells.slice(1)).toEqual([value(i, 0), value(i, 1), value(i, 2)]);
    }
  });

  it("carries every sample exactly once, in order", () => {
    for (let i = 0; i < TOTAL; i++) {
      if (Number(lines[i + 1].split(",")[1]) !== i) {
        throw new Error(`row ${i} holds ${lines[i + 1]}`);
      }
    }
  });

  it("has a monotonic timestamp column", () => {
    let previous = -Infinity;
    for (let i = 1; i < lines.length; i++) {
      const t = Number(lines[i].split(",")[0]);
      if (!(t > previous)) throw new Error(`row ${i - 1}: ${t} after ${previous}`);
      previous = t;
    }
  });

  it("writes a short track as a single, complete chunk", async () => {
    const small = await csvOf(await record(packets(5, 5, meta())), "rec_eeg_raw.csv");
    expect(small.split("\n")).toHaveLength(6);
    expect(small.endsWith("\n")).toBe(false);
  });

  it("writes a track that is exactly one chunk long", async () => {
    const exact = await csvOf(await record(packets(4096, 64, meta())), "rec_eeg_raw.csv");
    const rows = exact.split("\n");
    expect(rows).toHaveLength(4097);
    expect(rows[4096].split(",")[1]).toBe("4095");
  });

  it("keeps the label column on a categorical track", async () => {
    const markerMeta: StreamMetadata = {
      streamID: "rec:event_marker:raw",
      modality: Modality.EVENT_MARKER,
      valueType: "categorical",
      channelCount: 1,
      channelInfo: [{ index: 0, label: "marker" }],
    };
    const labels = Array.from({ length: 5000 }, (_, i) => (i % 2 ? "go" : "stop, now"));
    const marks: DataPacket = {
      streamID: "rec:event_marker:raw" as StreamIdentifierLiteral,
      timestamp: 5,
      data: Float32Array.from(labels, (_, i) => (i % 2 ? 1 : 2)),
      labels,
      metadata: markerMeta,
    };
    const out = (await csvOf(await record([marks]), "rec_event_marker_raw.csv")).split("\n");

    expect(out[0]).toBe("timestamp,label,marker");
    expect(out).toHaveLength(5001);
    // A label containing a comma is quoted, on both sides of a seam.
    expect(out[1]).toMatch(/^[\d.]+,"stop, now",2$/);
    expect(out[4097]).toMatch(/^[\d.]+,"stop, now",2$/);
    expect(out[4098]).toMatch(/^[\d.]+,go,1$/);
  });
});

describe("Recorder value storage", () => {
  it("writes exactly the text the float32 samples print as", async () => {
    // Random values that are not exactly representable, so any rounding in the
    // store (float32 -> float64 -> text) would show up as a different digit.
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296 - 0.5) * 200;
    const total = 20_000; // 60k values: spans several 16k-value chunks
    const all: DataPacket[] = [];
    const expected: string[] = ["timestamp,a,b,c"];
    for (let s = 0; s < total; s += 40) {
      const data = new Float32Array(40 * 3).map(() => rand());
      const timestamp = 1_724_716_800_123 + s * 10;
      all.push({ streamID: ID, timestamp, data, metadata: meta() });
      for (let i = 0; i < 40; i++) {
        expected.push(
          [timestamp + (i / 100) * 1000, data[i * 3], data[i * 3 + 1], data[i * 3 + 2]].join(",")
        );
      }
    }
    const csv = await csvOf(await record(all), "rec_eeg_raw.csv");
    expect(csv.split("\n")).toEqual(expected);
  });

  it("keeps 32-bit integers beyond float32's exact range", async () => {
    const big = Int32Array.from([16_777_217, -2_000_000_001, 2_147_483_647]);
    const csv = await csvOf(
      await record([
        {
          streamID: ID,
          timestamp: 1,
          data: big as unknown as Float32Array,
          metadata: meta({ samplingRate: undefined }),
        },
      ]),
      "rec_eeg_raw.csv"
    );
    expect(csv.split("\n")[1].split(",").slice(1).map(Number)).toEqual(Array.from(big));
  });
});

describe("Recorder → FileReplayReceiver", () => {
  it("reads back the samples that were recorded", async () => {
    const blob = await record(packets(6000, 30, meta()));
    // A browser's JSZip reads a Blob; Node's does not, so hand it the bytes.
    const archive = new Uint8Array(await blob.arrayBuffer()) as unknown as Blob;
    const replay = new FileReplayReceiver();
    await replay.connect(archive);

    const [track] = replay.trackInfo;
    expect(replay.trackInfo).toHaveLength(1);
    expect(track.channels).toEqual(["a", "b", "c"]);
    expect(track.samples).toBe(6000);
    expect(track.samplingRate).toBe(100);
  });
});
