/**
 * Shared plumbing for the golden-value tests: fixture loading, building the
 * packets an analyzer would receive, and a few reference-side helpers.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  Biquad,
  DataPacket,
  Modality,
  StreamMetadata,
  interleave,
} from "../../../src";

export interface GoldenSignal {
  description: string;
  fs: number;
  channels: number[][];
  truth?: { beats: number[]; hr: number; bpm: number };
}

const DIR = join(__dirname, "fixtures");

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as T;
}

export const inputs: Record<string, GoldenSignal> = fixture<{
  signals: Record<string, GoldenSignal>;
}>("_inputs").signals;

export function metadataFor(
  name: string,
  overrides: Partial<StreamMetadata> = {}
): StreamMetadata {
  const sig = inputs[name];
  return {
    streamID: `golden:${name.replace(/[^a-zA-Z0-9]/g, "")}:raw`,
    modality: Modality.EEG,
    samplingRate: sig.fs,
    channelCount: sig.channels.length,
    channelInfo: sig.channels.map((_, index) => ({ index, label: `ch${index}` })),
    ...overrides,
  };
}

/** The whole signal as one interleaved packet, as a Windowing node would emit. */
export function packetFor(
  name: string,
  options: { samples?: [number, number]; metadata?: Partial<StreamMetadata> } = {}
): DataPacket {
  const sig = inputs[name];
  const [start, stop] = options.samples ?? [0, sig.channels[0].length];
  const channels = sig.channels.map((c) => Float32Array.from(c.slice(start, stop)));
  const metadata = metadataFor(name, options.metadata);
  return {
    streamID: metadata.streamID,
    timestamp: start / sig.fs,
    data: interleave(channels),
    metadata,
  };
}

/** The signal cut into device-sized packets, as a receiver delivers it. */
export function packetStream(name: string, packetSize: number): DataPacket[] {
  const sig = inputs[name];
  const n = sig.channels[0].length;
  const out: DataPacket[] = [];
  for (let start = 0; start < n; start += packetSize) {
    out.push(packetFor(name, { samples: [start, Math.min(n, start + packetSize)] }));
  }
  return out;
}

/** Splits an interleaved packet's data back into channels. */
export function channelsOf(data: ArrayLike<number>, channelCount: number): number[][] {
  const samples = Math.floor(data.length / channelCount);
  return Array.from({ length: channelCount }, (_, c) =>
    Array.from({ length: samples }, (_, i) => data[i * channelCount + c])
  );
}

/** Magnitude response |H(f)| of a biquad cascade, evaluated on the unit circle. */
export function cascadeMagnitude(
  sections: Biquad[],
  frequencies: number[],
  samplingRate: number
): number[] {
  return frequencies.map((f) => {
    const w = (2 * Math.PI * f) / samplingRate;
    let magnitude = 1;
    for (const { b, a } of sections) {
      const evalPoly = (c: number[]) => {
        let re = 0;
        let im = 0;
        for (let k = 0; k < c.length; k++) {
          re += c[k] * Math.cos(-w * k);
          im += c[k] * Math.sin(-w * k);
        }
        return Math.hypot(re, im);
      };
      magnitude *= evalPoly(b) / evalPoly(a);
    }
    return magnitude;
  });
}

export function maxAbs(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

export function rmsOf(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}

/** Largest |a - b| over a slice, for edge-vs-interior error measurements. */
export function maxAbsDiff(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  start = 0,
  stop = Math.min(a.length, b.length)
): number {
  let m = 0;
  for (let i = start; i < stop; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export const toDb = (x: number) => 20 * Math.log10(x);
