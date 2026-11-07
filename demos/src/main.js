import "./style.css";
import {
  AnalysisMethod,
  ArduinoReceiver,
  BluetoothTransport,
  EMOTIVReceiver,
  FaceEmotionReceiver,
  FaceLandmarkReceiver,
  FaceOverlay,
  FileReplayReceiver,
  LSLReceiver,
  MicrophoneReceiver,
  Modality,
  MuseReceiver,
  Pipeline,
  RPPGReceiver,
  Recorder,
  SAMPLE_FORMATS,
  SerialTransport,
  SimulatedArduino,
  VideoReceiver,
  VoiceEmotionReceiver,
} from "yq-data";

/* -------------------------------------------------------------------------- */
/* Display helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Renders a packet as labelled channel values.
 *
 * Rendering is throttled per element rather than driven by every packet: raw
 * EEG arrives at 256 Hz and no one can read that, and touching the DOM at
 * that rate is what makes a naive demo feel broken.
 */
function makeRenderer(elementId, fps = 10) {
  const element = document.getElementById(elementId);
  const rows = new Map();
  let last = 0;

  return (packet) => {
    const channels = packet.metadata.channelCount ?? 1;
    const samples = packet.data.length / channels;
    const labels = packet.metadata.channelInfo;

    const values = [];
    for (let c = 0; c < channels; c++) {
      // Show the last sample of the packet for each channel.
      const value = packet.data[(samples - 1) * channels + c];
      values.push(`${labels?.[c]?.label ?? c}: ${value.toFixed(3)}`);
    }
    rows.set(packet.streamID, `${packet.streamID}\n  ${values.join("\n  ")}`);

    const now = performance.now();
    if (now - last < 1000 / fps) return;
    last = now;
    element.textContent = Array.from(rows.values()).join("\n\n");
  };
}

function fail(elementId, error) {
  document.getElementById(elementId).textContent = `Error: ${error.message}`;
  console.error(error);
}

function toggle(id, disabled) {
  document.getElementById(id).disabled = disabled;
}

/* -------------------------------------------------------------------------- */
/* Recording replay — the no-hardware path                                    */
/* -------------------------------------------------------------------------- */

const replay = new FileReplayReceiver();
const renderReplay = makeRenderer("replay-output");

document.getElementById("replay-file").addEventListener("change", async (e) => {
  const file = e.currentTarget.files?.[0];
  if (!file) return;

  try {
    await replay.connect(file);
    replay.data.subscribe(renderReplay);
    toggle("replay-play", false);
    toggle("replay-pause", false);
    document.getElementById("replay-output").textContent =
      `Loaded ${replay.trackInfo.length} stream(s), ${replay.duration.toFixed(1)}s:\n` +
      replay.trackInfo
        .map((t) => `  ${t.streamID} — ${t.channels.length} ch @ ${t.samplingRate} Hz`)
        .join("\n");
  } catch (error) {
    fail("replay-output", error);
  }
});

document.getElementById("replay-play").addEventListener("click", () => replay.startStream());
document.getElementById("replay-pause").addEventListener("click", () => replay.stopStream());
document.getElementById("replay-loop").addEventListener("change", (e) => {
  replay.loop = e.currentTarget.checked;
});

const progressBar = document.getElementById("replay-progress");
replay.progress$.subscribe((value) => (progressBar.value = value));

/* -------------------------------------------------------------------------- */
/* Muse — the canonical pipeline                                              */
/* -------------------------------------------------------------------------- */

const muse = new MuseReceiver();
const recorder = new Recorder();

/**
 * Two independent branches off one headset: EEG through band power, and PPG
 * through heart rate. The graph below is exactly the JSON a stored data
 * source block would hold, and every generation of Muse runs the same one.
 */
const musePipeline = new Pipeline({
  nodes: [
    { id: "eeg", receiver: "muse", stream: Modality.EEG },
    {
      id: "eeg-clean",
      method: AnalysisMethod.FILTERING,
      parameters: { kind: "bandpass", cutoff: [1, 45], order: 4 },
    },
    {
      id: "eeg-window",
      method: AnalysisMethod.WINDOWING,
      parameters: { size: 2, hop: 0.1 },
    },
    { id: "bands", method: AnalysisMethod.BAND_POWER, label: "Band power" },

    { id: "ppg", receiver: "muse", stream: Modality.PPG },
    {
      id: "ppg-channel",
      method: AnalysisMethod.CHANNEL_SELECTION,
      // The channel carrying the pulse: "infrared" on a Muse 2 or classic S,
      // "LI_RED" on an Athena. A label the stream does not have is skipped.
      parameters: { labels: ["infrared", "LI_RED"] },
    },
    {
      id: "ppg-window",
      method: AnalysisMethod.WINDOWING,
      parameters: { size: 10, hop: 1 },
    },
    { id: "hr", method: AnalysisMethod.HEART_RATE, label: "Heart rate" },
  ],
  edges: [
    { from: ["eeg"], to: ["eeg-clean"] },
    { from: ["eeg-clean"], to: ["eeg-window"] },
    { from: ["eeg-window"], to: ["bands"] },

    { from: ["ppg"], to: ["ppg-channel"] },
    { from: ["ppg-channel"], to: ["ppg-window"] },
    { from: ["ppg-window"], to: ["hr"] },
  ],
});

const renderMuse = makeRenderer("muse-output");

document.getElementById("muse-connect").addEventListener("click", async () => {
  try {
    await muse.connect();

    musePipeline.attachReceiver("muse", muse);
    musePipeline.start();
    musePipeline.data.subscribe(renderMuse);

    recorder.addReceiver(muse);

    // Last, because an Athena only returns from this seconds after its data
    // has started flowing.
    await muse.startStream();

    toggle("muse-connect", true);
    toggle("muse-disconnect", false);
    toggle("muse-record", false);
  } catch (error) {
    fail("muse-output", error);
  }
});

document.getElementById("muse-disconnect").addEventListener("click", async () => {
  await muse.disconnect();
  musePipeline.stop();
  toggle("muse-connect", false);
  toggle("muse-disconnect", true);
});

document.getElementById("muse-record").addEventListener("click", () => {
  recorder.start();
  toggle("muse-record", true);
  toggle("muse-save", false);
});

document.getElementById("muse-save").addEventListener("click", async () => {
  recorder.stop();
  // The zip this writes is what the replay panel above reads.
  await recorder.download();
  toggle("muse-record", false);
  toggle("muse-save", true);
});

/* -------------------------------------------------------------------------- */
/* EMOTIV                                                                     */
/* -------------------------------------------------------------------------- */

const renderEmotiv = makeRenderer("emotiv-output");

document.getElementById("emotiv-connect").addEventListener("click", async () => {
  try {
    const emotiv = new EMOTIVReceiver({
      license: import.meta.env.VITE_CORTEX_LICENSE,
      clientId: import.meta.env.VITE_CORTEX_CLIENT_ID,
      clientSecret: import.meta.env.VITE_CORTEX_CLIENT_SECRET,
      debit: 1,
    });

    await emotiv.connect(["pow", "met"]);
    emotiv.startStream();
    emotiv.data.subscribe(renderEmotiv);
  } catch (error) {
    fail("emotiv-output", error);
  }
});

/* -------------------------------------------------------------------------- */
/* Camera — one feed, two analyses                                            */
/* -------------------------------------------------------------------------- */

let camera;
let face;
let faceEmotion;
let rppg;
let faceOverlay;
let emotionOverlay;
const renderCameraValues = makeRenderer("camera-output", 5);

// Geometry is for the overlays; 1434 landmark channels would bury the text.
const renderCamera = (packet) => {
  if (/:(landmarks|face_box)(_face_\d+)?$/.test(packet.streamID)) return;
  renderCameraValues(packet);
};

const rppgPipeline = new Pipeline({
  nodes: [
    { id: "rgb", receiver: "rppg" },
    {
      id: "green",
      method: AnalysisMethod.CHANNEL_SELECTION,
      parameters: { labels: ["green"] },
    },
    {
      id: "window",
      method: AnalysisMethod.WINDOWING,
      parameters: { size: 10, hop: 1 },
    },
    {
      id: "bpm",
      method: AnalysisMethod.HEART_RATE,
      parameters: { strategy: "spectral" },
      label: "Heart rate (camera)",
    },
  ],
  edges: [
    { from: ["rgb"], to: ["green"] },
    { from: ["green"], to: ["window"] },
    { from: ["window"], to: ["bpm"] },
  ],
});

document.getElementById("camera-connect").addEventListener("click", async () => {
  try {
    const video = document.getElementById("camera-video");

    camera = new VideoReceiver(video, { frameRate: 30 });
    await camera.connect();
    await camera.startStream();

    // Both receivers read the same element — the camera is opened once.
    face = new FaceLandmarkReceiver(video, {
      maxFps: 15,
      emitFaceBox: true,
      emitLandmarks: true,
    });
    await face.connect();
    face.startStream();
    face.data.subscribe(renderCamera);

    // Overlays draw from streams, not receivers: the same code would draw
    // these faces from a RemoteStreamReceiver on another machine.
    faceOverlay = new FaceOverlay(document.getElementById("face-overlay"), {
      video,
      // Contours by default; `connections: "mesh"` draws the full triangulation.
      layers: { box: false, landmarks: false },
    });
    faceOverlay.attach(face);
    faceOverlay.start();

    // A detector plus two classifier passes is heavier than the MediaPipe
    // graph above, so it gets a slower frame budget on the same feed.
    faceEmotion = new FaceEmotionReceiver(video, { maxFps: 10, emitFaceBox: true });
    await faceEmotion.connect();
    faceEmotion.startStream();
    faceEmotion.data.subscribe(renderCamera);

    emotionOverlay = new FaceOverlay(document.getElementById("emotion-overlay"), {
      video,
      style: { color: "#ffcc33" },
    });
    emotionOverlay.attach(faceEmotion);
    emotionOverlay.start();

    rppg = new RPPGReceiver(video, { maxFps: 30, region: "forehead" });
    await rppg.connect();
    rppg.startStream();

    rppgPipeline.attachReceiver("rppg", rppg);
    rppgPipeline.start();
    rppgPipeline.getOutput("bpm").subscribe(renderCamera);

    toggle("camera-connect", true);
    toggle("camera-disconnect", false);
  } catch (error) {
    fail("camera-output", error);
  }
});

document.getElementById("camera-disconnect").addEventListener("click", async () => {
  rppgPipeline.stop();
  faceOverlay?.destroy();
  emotionOverlay?.destroy();
  await face?.disconnect();
  await faceEmotion?.disconnect();
  await rppg?.disconnect();
  await camera?.disconnect();
  toggle("camera-connect", false);
  toggle("camera-disconnect", true);
});

/* -------------------------------------------------------------------------- */
/* Microphone                                                                 */
/* -------------------------------------------------------------------------- */

let microphone;
const renderMic = makeRenderer("mic-output");

const micPipeline = new Pipeline({
  nodes: [
    { id: "audio", receiver: "mic", stream: Modality.AUDIO },
    {
      id: "window",
      method: AnalysisMethod.WINDOWING,
      parameters: { size: 0.1, hop: 0.05 },
    },
    {
      id: "volume",
      method: AnalysisMethod.RMS,
      parameters: { decibels: true },
      label: "Volume",
    },
  ],
  edges: [
    { from: ["audio"], to: ["window"] },
    { from: ["window"], to: ["volume"] },
  ],
});

document.getElementById("mic-connect").addEventListener("click", async () => {
  try {
    microphone = new MicrophoneReceiver();
    await microphone.connect();
    await microphone.startStream();

    micPipeline.attachReceiver("mic", microphone);
    micPipeline.start();
    micPipeline.getOutput("volume").subscribe(renderMic);

    toggle("mic-connect", true);
    toggle("mic-disconnect", false);
  } catch (error) {
    fail("mic-output", error);
  }
});

document.getElementById("mic-disconnect").addEventListener("click", async () => {
  micPipeline.stop();
  await microphone?.disconnect();
  toggle("mic-connect", false);
  toggle("mic-disconnect", true);
});

/* -------------------------------------------------------------------------- */
/* Voice emotion                                                              */
/* -------------------------------------------------------------------------- */

let voice;

// Rendered at full rate rather than throttled: this receiver emits once per
// spoken phrase, so there is nothing to throttle.
const renderVoice = makeRenderer("voice-output", Infinity);

document.getElementById("voice-connect").addEventListener("click", async () => {
  try {
    voice = new VoiceEmotionReceiver({
      emitAffect: true,
      // The package default fetches this model from jsDelivr. The demo
      // serves the repository's own copy instead (public/models is a symlink
      // to ../models), so it also works offline and against local edits.
      modelPath: "/models/voice-emotion",
    });
    await voice.connect();
    await voice.startStream();
    voice.data.subscribe(renderVoice);

    document.getElementById("voice-output").textContent = "Listening…";
    toggle("voice-connect", true);
    toggle("voice-disconnect", false);
  } catch (error) {
    fail("voice-output", error);
  }
});

document
  .getElementById("voice-disconnect")
  .addEventListener("click", async () => {
    await voice?.disconnect();
    toggle("voice-connect", false);
    toggle("voice-disconnect", true);
  });

/* -------------------------------------------------------------------------- */
/* Arduino                                                                    */
/* -------------------------------------------------------------------------- */

let arduino;
let arduinoTransport;
let arduinoSubscriptions = [];
let arduinoTimers = [];
let arduinoDraw;
const arduinoRows = new Map();

/**
 * A board in memory that announces a sine-wave sensor, a button and an LED
 * output, so the panel can be tried without hardware. It is the same
 * protocol over the same transport as a real board; only the port is fake.
 */
function simulatedBoard() {
  const sim = new SimulatedArduino({
    id: "sim-1",
    name: "Simulated board",
    firmware: "yq-data demo",
    streams: [
      { name: "pot", format: "uint16", rate: 50, scale: 5 / 1024, unit: "V" },
      { name: "button", format: "uint8", categories: ["released", "pressed"] },
      { name: "led", sink: true, format: "uint8", scale: 1 / 255 },
    ],
  });

  // A board only sends while it has been told to start; emit() knows that.
  let sample = 0;
  const sensor = setInterval(() => {
    const values = [];
    for (let i = 0; i < 5; i++) {
      values.push(2.5 + 2.5 * Math.sin((2 * Math.PI * 0.2 * sample++) / 50));
    }
    sim.emit("pot", values);
  }, 100);

  const button = setInterval(() => {
    sim.emitRaw("button", [1]);
    setTimeout(() => sim.emitRaw("button", [0]), 500);
  }, 3000);

  arduinoTimers.push(sensor, button);
  return sim;
}

/** The describing text above the live values: who the board is, what it offers. */
function arduinoHeader() {
  const { board } = arduino.protocol;
  const describe = (s) =>
    `${s.name} — ${s.categories ? `${s.categories.join(" / ")}` : `${s.channels} ch`}` +
    `${s.rate ? ` @ ${s.rate} Hz` : ""}${s.unit ? ` (${s.unit})` : ""}`;

  return [
    `${board?.name ?? "Board"} · id ${board?.id}` +
      `${board?.firmware ? ` · firmware ${board.firmware}` : ""}`,
    ...arduino.sources.map((s) => `  in   ${describe(s)}`),
    ...arduino.sinks.map((s) => `  out  ${describe(s)}`),
  ].join("\n");
}

/** Draws the header and the latest value of every stream, at most 10 times a second. */
function scheduleArduinoDraw() {
  if (arduinoDraw) return;
  arduinoDraw = setTimeout(() => {
    arduinoDraw = undefined;
    if (!arduino) return;
    const { stats } = arduinoTransport;
    document.getElementById("arduino-output").textContent =
      `${arduinoHeader()}\n\n${Array.from(arduinoRows.values()).join("\n\n")}\n\n` +
      `frames ${stats.frames}, dropped ${stats.dropped.crc + stats.dropped.cobs + stats.dropped.length + stats.dropped.decode}`;
  }, 100);
}

function renderArduino(packet) {
  const source = arduino.sources.find((s) => s.streamID === packet.streamID);
  const channels = source?.channels ?? packet.metadata.channelCount ?? 1;
  const last = packet.data.length - channels;

  let values;
  if (packet.labels) {
    // A categorical stream sends events, not samples: show the last one.
    values = [packet.labels[packet.labels.length - 1]];
  } else {
    values = [];
    for (let c = 0; c < channels; c++) {
      values.push(
        `${source?.labels?.[c] ?? c}: ${packet.data[last + c].toFixed(3)}${source?.unit ? ` ${source.unit}` : ""}`
      );
    }
  }
  arduinoRows.set(packet.streamID, `${source?.name ?? packet.streamID}\n  ${values.join("\n  ")}`);
  scheduleArduinoDraw();
}

/**
 * One row per sink, one slider per channel. The range and step come from how
 * the board quantises the sink, so a slider can reach exactly the values the
 * board can represent and no others.
 */
function buildSinkControls() {
  const container = document.getElementById("arduino-sinks");
  container.replaceChildren();

  for (const sink of arduino.sinks) {
    const format = SAMPLE_FORMATS[sink.format];
    const low = format.min * sink.scale + sink.offset;
    const high = format.max * sink.scale + sink.offset;
    const sliders = [];

    for (let c = 0; c < sink.channels; c++) {
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.className = "sink-name";
      name.textContent = sink.channels > 1 ? `${sink.name} ${sink.labels?.[c] ?? c}` : sink.name;

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(Math.min(low, high));
      slider.max = String(Math.max(low, high));
      slider.step = String(Math.abs(sink.scale));
      slider.value = String(Math.min(Math.max(0, low), high));

      const readout = document.createElement("span");
      const show = () => (readout.textContent = Number(slider.value).toFixed(2));
      show();

      slider.addEventListener("input", () => {
        show();
        // A sink takes all its channels together, interleaved.
        arduino.write(sink.name, sliders.map((s) => Number(s.value)));
      });

      sliders.push(slider);
      label.append(name, slider, readout);
      container.append(label);
    }
  }
}

/** Connecting locks the pickers; being connected unlocks ping and disconnect. */
function setArduinoState(state) {
  const idle = state === "idle";
  toggle("arduino-connect", !idle);
  toggle("arduino-bluetooth", !idle);
  toggle("arduino-simulate", !idle);
  toggle("arduino-baud", !idle);
  toggle("arduino-ping", state !== "connected");
  toggle("arduino-disconnect", state !== "connected");
}

async function startArduino(transport, simulated) {
  const output = document.getElementById("arduino-output");
  setArduinoState("connecting");
  output.textContent = simulated
    ? "Starting the simulated board…"
    : transport.kind === "bluetooth"
      ? "Connecting to the board…"
      : "Waiting for the board. Opening the port resets most boards, which takes a second or two…";

  const board = new ArduinoReceiver(transport);
  try {
    await board.connect();
  } catch (error) {
    transport.close();
    throw error;
  }

  arduino = board;
  arduinoTransport = transport;

  // Subscribed before the stream starts, and the stream started only once the
  // handshake is done. A board that kept streaming from an earlier session (a
  // Bluetooth module is not reset when it connects) goes quiet on our hello,
  // but anything it sent before that arrives while the receiver is not yet
  // streaming, and is dropped.
  arduinoSubscriptions.push(board.data.subscribe(renderArduino));
  arduinoSubscriptions.push(
    transport.isOpen$.subscribe((open) => {
      if (!open && arduino === board) {
        output.textContent = "The board disconnected.";
        void stopArduino();
      }
    })
  );

  buildSinkControls();
  board.startStream();
  setArduinoState("connected");
  scheduleArduinoDraw();
}

async function stopArduino() {
  const board = arduino;
  const transport = arduinoTransport;
  arduino = undefined;
  arduinoTransport = undefined;

  arduinoSubscriptions.forEach((s) => s.unsubscribe());
  arduinoSubscriptions = [];
  arduinoTimers.forEach(clearInterval);
  arduinoTimers = [];
  clearTimeout(arduinoDraw);
  arduinoDraw = undefined;
  arduinoRows.clear();
  document.getElementById("arduino-sinks").replaceChildren();

  await board?.disconnect();
  // Wait for the port to be released, or picking it again would fail.
  await transport?.closed;
  setArduinoState("idle");
}

document.getElementById("arduino-connect").addEventListener("click", async () => {
  try {
    // No `filters`: the picker then lists every serial port, including the
    // ones a Bluetooth module shows up as. A USB vendor filter would hide them.
    const transport = await SerialTransport.request({
      baudRate: Number(document.getElementById("arduino-baud").value) || 115200,
    });
    await startArduino(transport);
  } catch (error) {
    setArduinoState("idle");
    fail("arduino-output", error);
  }
});

document.getElementById("arduino-bluetooth").addEventListener("click", async () => {
  try {
    await startArduino(await BluetoothTransport.request());
  } catch (error) {
    setArduinoState("idle");
    fail("arduino-output", error);
  }
});

document.getElementById("arduino-simulate").addEventListener("click", async () => {
  try {
    await SimulatedArduino.load();
    const simulation = simulatedBoard();
    await startArduino(new SerialTransport(simulation.port), true);
  } catch (error) {
    arduinoTimers.forEach(clearInterval);
    arduinoTimers = [];
    setArduinoState("idle");
    fail("arduino-output", error);
  }
});

document.getElementById("arduino-ping").addEventListener("click", async () => {
  try {
    const { roundTrip } = await arduino.ping();
    arduinoRows.set("ping", `ping\n  round trip: ${roundTrip.toFixed(1)} ms`);
  } catch (error) {
    arduinoRows.set("ping", `ping\n  ${error.message}`);
  }
  scheduleArduinoDraw();
});

document.getElementById("arduino-disconnect").addEventListener("click", () => stopArduino());

/* -------------------------------------------------------------------------- */
/* LSL                                                                        */
/* -------------------------------------------------------------------------- */

const renderLSL = makeRenderer("lsl-output");

document.getElementById("lsl-connect").addEventListener("click", async () => {
  try {
    const lsl = new LSLReceiver();
    await lsl.connect(document.getElementById("lsl-url").value);
    lsl.startStream();
    lsl.data.subscribe(renderLSL);
  } catch (error) {
    fail("lsl-output", error);
  }
});
