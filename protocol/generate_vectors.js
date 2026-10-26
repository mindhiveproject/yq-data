/**
 * Generates protocol/vectors.json, the shared test vectors for `yq-arduino`.
 *
 * Deliberately independent of src/: CRC-16, COBS and framing are written out
 * again here, and MessagePack comes straight from @msgpack/msgpack. The TypeScript
 * implementation is tested against this file, and so is the Arduino library, so
 * if the two ever disagree the vectors — not either implementation — are right.
 *
 *   node protocol/generate_vectors.js
 */
const fs = require("fs");
const path = require("path");
const { encode } = require("@msgpack/msgpack");

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function cobsEncode(bytes) {
  const out = [0];
  let codeIndex = 0;
  let code = 1;
  let lastBlockFull = false;
  for (const byte of bytes) {
    lastBlockFull = false;
    if (byte === 0) {
      out[codeIndex] = code;
      codeIndex = out.length;
      out.push(0);
      code = 1;
    } else {
      out.push(byte);
      code++;
      if (code === 0xff) {
        out[codeIndex] = code;
        codeIndex = out.length;
        out.push(0);
        code = 1;
        lastBlockFull = true;
      }
    }
  }
  // Input that ends exactly on a full 254-byte block gets no empty block after
  // it. This is what keeps a 254-byte payload at 255 bytes encoded, so the
  // protocol's "COBS adds exactly one byte" bound holds. A decoder accepts both.
  if (lastBlockFull) out.pop();
  else out[codeIndex] = code;
  return Uint8Array.from(out);
}

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
const fromHex = (text) =>
  Uint8Array.from(text.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16)));

const bin = (bytes) => ({ $bin: hex(bytes) });
const int16 = (...values) => {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buffer.writeInt16LE(v, i * 2));
  return buffer;
};

/** Replaces `{ $bin }` placeholders with real bytes before MessagePack sees them. */
function materialise(value) {
  if (Array.isArray(value)) return value.map(materialise);
  if (value && typeof value === "object") {
    if ("$bin" in value) return fromHex(value.$bin);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, materialise(v)])
    );
  }
  return value;
}

function frameFor(message) {
  const body = encode(materialise(message), { forceFloat32: true });
  const crc = crc16(body);
  const withCrc = Uint8Array.from([...body, crc & 0xff, crc >> 8]);
  const frame = Uint8Array.from([...cobsEncode(withCrc), 0]);
  return { body, crc, frame };
}

/* ------------------------------------------------------------------ CRC */

const crcCases = ["123456789", "", "A", "yq-arduino"].map((text) => ({
  input: hex(Buffer.from(text)),
  text,
  crc: crc16(Buffer.from(text)).toString(16).padStart(4, "0"),
}));
if (crcCases[0].crc !== "29b1") throw new Error("CRC-16/CCITT-FALSE check value is wrong");

/* ----------------------------------------------------------------- COBS */

const run = (from, to) => Uint8Array.from({ length: to - from + 1 }, (_, i) => from + i);

const cobsInputs = [
  ["one zero", [0x00]],
  ["two zeros", [0x00, 0x00]],
  ["zero in the middle", [0x00, 0x11, 0x00]],
  ["zero inside", [0x11, 0x22, 0x00, 0x33]],
  ["no zeros", [0x11, 0x22, 0x33, 0x44]],
  ["trailing zeros", [0x11, 0x00, 0x00, 0x00]],
  ["empty", []],
  ["254 nonzero bytes", run(0x01, 0xfe)],
  ["255 bytes starting at zero", run(0x00, 0xfe)],
  ["255 nonzero bytes", run(0x01, 0xff)],
  ["255 bytes ending in zero", [...run(0x02, 0xff), 0x00]],
].map(([name, bytes]) => ({
  name,
  decoded: hex(bytes),
  encoded: hex(cobsEncode(Uint8Array.from(bytes))),
}));

// Well-known COBS examples; a wrong generator should fail here, not ship.
const known = {
  "one zero": "01 01",
  "two zeros": "01 01 01",
  "zero in the middle": "01 02 11 01",
  "zero inside": "03 11 22 02 33",
  "no zeros": "05 11 22 33 44",
  "trailing zeros": "02 11 01 01 01",
};
const encodedLength = { "254 nonzero bytes": 255, "255 bytes starting at zero": 256, "255 nonzero bytes": 257, "255 bytes ending in zero": 257 };
for (const c of cobsInputs) {
  const length = c.encoded.split(" ").filter(Boolean).length;
  if (encodedLength[c.name] && encodedLength[c.name] !== length) {
    throw new Error(`COBS "${c.name}": expected ${encodedLength[c.name]} bytes, got ${length}`);
  }
  if (known[c.name] && known[c.name] !== c.encoded) {
    throw new Error(`COBS "${c.name}": expected ${known[c.name]}, got ${c.encoded}`);
  }
}

/* --------------------------------------------------------------- Frames */

const messages = [
  ["board", [1, { v: 1, id: "uno-1", tu: "ms", mf: 64, ns: 1 }]],
  ["board with name and firmware", [1, { v: 1, id: "esp-1", tu: "us", mf: 254, ns: 3, name: "ESP32 rig", fw: "0.1.0" }]],
  ["stream: 10-bit pin", [2, { i: 0, n: "pot", m: "unknown", c: 1, r: 50, f: 1, k: 0.0048828125 }]],
  ["stream: labelled accelerometer", [2, { i: 1, n: "imu", m: "accelerometer", c: 3, r: 100, f: 0, k: 0.00048828125, l: ["x", "y", "z"], u: "g" }]],
  ["stream: categorical button", [2, { i: 2, n: "button", m: "event_marker", f: 3, q: ["released", "pressed"] }]],
  ["stream: sink", [2, { i: 3, n: "led", m: "unknown", d: 1, f: 3 }]],
  ["stream: offset and signed", [2, { i: 4, n: "temp", m: "temperature", r: 1, f: 0, k: 0.01, o: 20, u: "°C" }]],
  ["data: three int16 samples", [3, 1, 123456, bin(int16(100, -2, 3000))]],
  ["data: zero time", [3, 0, 0, bin(int16(1, 2))]],
  ["data: max uint32 time", [3, 0, 4294967295, bin(int16(-32768, 32767))]],
  ["data: embedded zeros", [3, 1, 256, bin(int16(0, 0, 0))]],
  ["data: high index", [3, 200, 70000, bin(Uint8Array.from([1]))]],
  ["data: sink uint8", [3, 3, 1000, bin(Uint8Array.from([255, 0, 128]))]],
  ["hello", [4, 1]],
  ["start", [5]],
  ["stop", [6]],
  ["ping", [7, 42]],
  ["pong", [8, 42, 123456]],
];

const frames = messages.map(([name, message]) => {
  const { body, crc, frame } = frameFor(message);
  return {
    name,
    message,
    body: hex(body),
    crc: crc.toString(16).padStart(4, "0"),
    frame: hex(frame),
  };
});

const byName = Object.fromEntries(frames.map((f) => [f.name, f]));

/* A maximum-size data frame: 240 payload bytes, COBS adds exactly one byte. */
{
  const payload = Uint8Array.from({ length: 240 }, (_, i) => (i * 7 + 1) & 0xff);
  const { body, crc, frame } = frameFor([3, 1, 4294967295, bin(payload)]);
  if (body.length + 2 > 254) throw new Error("maximum frame exceeds 254 bytes");
  frames.push({
    name: "data: maximum payload",
    message: [3, 1, 4294967295, bin(payload)],
    body: hex(body),
    crc: crc.toString(16).padStart(4, "0"),
    frame: hex(frame),
  });
}

/* ------------------------------------------------------------- Invalid */

const flipped = fromHex(byName["start"].frame);
flipped[flipped.length - 3] ^= 0x01; // a CRC byte

const invalidFrames = [
  { name: "wrong CRC", frame: hex(flipped), reason: "crc" },
  { name: "COBS run past the end", frame: "05 01 02 00", reason: "cobs" },
  { name: "valid CRC, body is not MessagePack of the right shape", frame: hex(frameFor("not an array").frame), reason: "shape" },
];

/* -------------------------------------------------------------- Streams */

const stream = [
  "00",
  byName["hello"].frame,
  "ff ff ff 00", // garbage: counted as one dropped frame
  "00 00", // empty frames: ignored, not counted
  byName["start"].frame,
].join(" ");

const byteStreams = [
  {
    name: "resynchronises after garbage and ignores empty frames",
    bytes: stream.replace(/\s+/g, " "),
    messages: ["hello", "start"],
    dropped: 1,
  },
  {
    name: "frames split across arbitrary chunk boundaries",
    bytes: [byName["hello"].frame, byName["start"].frame, byName["stop"].frame].join(" "),
    messages: ["hello", "start", "stop"],
    dropped: 0,
  },
];

/* ----------------------------------------------------------------- Out */

const output = {
  protocol: "yq-arduino",
  version: 1,
  note: "Generated by protocol/generate_vectors.js. Do not edit by hand. All byte strings are hex. A { $bin } value is a MessagePack bin of those bytes.",
  crc16: { algorithm: "CRC-16/CCITT-FALSE", cases: crcCases },
  cobs: cobsInputs,
  frames,
  invalidFrames,
  byteStreams,
};

fs.writeFileSync(
  path.join(__dirname, "vectors.json"),
  JSON.stringify(output, null, 2) + "\n"
);
console.log(`wrote ${frames.length} frames, ${cobsInputs.length} COBS cases`);
