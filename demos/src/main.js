import "./style.css";
import {
  AnalysisMethod,
  EMOTIVReceiver,
  FaceEmotionReceiver,
  FaceLandmarkReceiver,
  FileReplayReceiver,
  LSLReceiver,
  MicrophoneReceiver,
  Modality,
  MuseReceiver,
  Pipeline,
  RPPGReceiver,
  Recorder,
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
 * source block would hold.
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
      // The infrared channel carries the pulse; ambient and red do not.
      parameters: { labels: ["infrared"] },
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
    await muse.startStream();

    musePipeline.attachReceiver("muse", muse);
    musePipeline.start();
    musePipeline.data.subscribe(renderMuse);

    recorder.addReceiver(muse);

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
const renderCamera = makeRenderer("camera-output", 5);

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
    face = new FaceLandmarkReceiver(video, { maxFps: 15 });
    await face.connect();
    face.startStream();
    face.data.subscribe(renderCamera);

    // A detector plus two classifier passes is heavier than the MediaPipe
    // graph above, so it gets a slower frame budget on the same feed.
    faceEmotion = new FaceEmotionReceiver(video, { maxFps: 10 });
    await faceEmotion.connect();
    faceEmotion.startStream();
    faceEmotion.data.subscribe(renderCamera);

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
