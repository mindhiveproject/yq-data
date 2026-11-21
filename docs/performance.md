# Performance

Everything runs on the page's main thread, so the question for a session is how
much of one core it takes and whether any single packet takes long enough to
stutter a display. `npm run bench` answers both on the machine it runs on. It
feeds each chain the signal a real device delivers, in the packet sizes it
delivers them, and reports **load**: processing time divided by signal time. 5%
means the chain needs a twentieth of a core to keep up with a live device, and
100% means it falls behind.

Measured on an Apple M4 Pro under Node 26. That is a fast machine, so read the
shape of these numbers rather than the digits, and run the benchmark on the
oldest hardware you expect.

| Chain | Load | Cost per second of signal |
|---|---|---|
| Muse EEG: bandpass → 2 s window → band power | 0.06% | 0.6 ms |
| Muse EEG, per-channel band power, 4 s window | 0.09% | 0.9 ms |
| Muse PPG: 10 s window → heart rate | 0.01% | 0.06 ms |
| Muse PPG: 30 s window, every 0.25 s, with HRV | 0.04% | 0.4 ms |
| Camera: POS → 10 s window → heart rate | 0.01% | 0.1 ms |
| LSL, 32 ch at 1 kHz: bandpass → 2 s window → per-channel band power | 0.7% | 6.8 ms |

Through a whole `Pipeline` the Muse graph costs the same, and its slowest packet
in a minute took about 0.3 ms. Memory is flat over a simulated hour. Building,
`issues()` and `describe()` on a 36-node graph each take under 0.1 ms, so a node
editor can call them on every edit.

What dominates, and what to expect when you change it:

- **The spectrum is the one expensive primitive.** A Hamming-windowed power
  spectrum takes 4 µs at 256 points, 31 µs at 2048 and 134 µs at 8192, and it
  scales with the length of the window times the number of channels, once per
  window emitted. `BandPower` and `SpectrumAnalyzer` pay it; filters, `Windowing`,
  statistics, POS and the beat detector cost microseconds.
- **Output rate is a knob.** A window with `hop: 0.1` emits ten times a second;
  `hop: 0.5` costs a fifth as much and is rarely distinguishable on screen.
- **Windows grow the buffer, not the cost per sample.** A 10 s window of 32
  channels at 1 kHz costs about 0.3 ms to assemble.

Not covered by the benchmark, because it needs a browser and a device:

- **Camera receivers** are dominated by the vision model, which runs
  synchronously on the main thread and so delays everything else on the page
  while it runs. `maxFps` is the cost control (30 by default for MediaPipe, 15
  for `FaceEmotionReceiver`, whose network is heavier). The default `delegate:
  "GPU"` is much faster than `"CPU"` but needs WebGL. Where that is missing,
  `connect()` fails and the receiver must be built with `delegate: "CPU"`.
  `RPPGReceiver` reads pixels from a downscaled crop of the face rather than the
  frame, and shares a `FaceLandmarkReceiver` through `faceSource` instead of
  running the model twice.
- **`FaceOverlay`** redraws on every animation frame. `connections: "mesh"`
  strokes 2556 edges and is much heavier than the default contours.
- **Microphone** audio crosses to the page in 2048-frame packets by transfer, not
  copy; `framesPerPacket` trades latency for message count.

Sending and recording have costs of their own:

- **Over a `WebSocketTransport` (JSON)** a Muse's raw EEG is about 20 KB/s, and
  a windowed 512 × 4 packet is 36 KB. The 478-point `landmarks` stream is 27 KB
  per frame, or about 800 KB/s at 30 fps: send it at a lower `maxFps`, or supply
  a binary `WireCodec`, rather than relying on JSON for it.
- **`Recorder` holds every sample in memory** until you export: 4 bytes a value
  (float32, as the samples arrive) and 8 for each sample's timestamp. That is
  about 21 MB an hour for a Muse and about 470 MB an hour for 32 channels at
  1 kHz. `maxSamplesPerStream` (2 million per stream by default) is counted in
  samples per channel, so it stops a Muse after 2.2 hours but 32 channels at
  1 kHz after 33 minutes, by which time it holds about 270 MB. Lower it for
  dense streams. Export writes the CSV in chunks, so its size is bounded by
  memory rather than by the length of a string, but the archive is built in
  memory too: a 15-minute 32-channel recording peaks at about 2 GB while it
  exports. `FileReplayReceiver` reads each CSV back as one string, so it cannot
  open a single stream much beyond half a gigabyte of CSV.
