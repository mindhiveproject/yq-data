# References and attribution

Methods:

- Charlton, P.H., Mant, J. & Kyriacou, P.A. (2025). The MSPTDfast
  photoplethysmography beat detection algorithm: design, benchmarking, and
  open-source distribution. *Physiological Measurement*, 46, 035002.
  [doi:10.1088/1361-6579/adb89e](https://doi.org/10.1088/1361-6579/adb89e)
  — the beat detector behind `HEART_RATE`, ported from the MIT-licensed
  [ppg-beats](https://github.com/peterhcharlton/ppg-beats) toolbox.
- Bishop, S.M. & Ercole, A. (2018). Multi-scale peak and trough detection
  optimised for periodic and quasi-periodic neuroscience data. *Acta
  Neurochirurgica Supplement*, 126, 189–195.
  [doi:10.1007/978-3-319-65798-1_39](https://doi.org/10.1007/978-3-319-65798-1_39)
  — MSPTD, which MSPTDfast refines.
- Charlton, P.H. et al. (2022). Detecting beats in the photoplethysmogram:
  benchmarking open-source algorithms. *Physiological Measurement*, 43(8),
  085007. [doi:10.1088/1361-6579/ac826d](https://doi.org/10.1088/1361-6579/ac826d)
  — the benchmark the detector was chosen from.
- Shin, H.S., Lee, C. & Lee, M. (2009). Adaptive threshold method for the peak
  detection of photoplethysmographic waveform. *Computers in Biology and
  Medicine*, 39(12), 1145–1152.
  [doi:10.1016/j.compbiomed.2009.10.006](https://doi.org/10.1016/j.compbiomed.2009.10.006)
  — `HEART_RATE`'s `detector: "adaptive-threshold"`.
- Wang, W., den Brinker, A.C., Stuijk, S. & de Haan, G. (2017). Algorithmic
  principles of remote PPG. *IEEE Transactions on Biomedical Engineering*,
  64(7), 1479–1491.
  [doi:10.1109/TBME.2016.2609282](https://doi.org/10.1109/TBME.2016.2609282)
  — POS, `PULSE_EXTRACTION`'s default algorithm.
- Verkruysse, W., Svaasand, L.O. & Nelson, J.S. (2008). Remote
  plethysmographic imaging using ambient light. *Optics Express*, 16(26),
  21434–21445. [doi:10.1364/OE.16.021434](https://doi.org/10.1364/OE.16.021434)
  — the green channel alone, `PULSE_EXTRACTION`'s `algorithm: "green"`.
- Kim, D.-Y., Lee, K. & Sohn, C.-B. (2021). Assessment of ROI Selection for
  Facial Video-Based rPPG. *Sensors*, 21(23), 7923.
  [doi:10.3390/s21237923](https://doi.org/10.3390/s21237923) — why
  `RPPGReceiver` samples the forehead and the cheeks together.
- Lugaresi, C., Tang, J., Nash, H., McClanahan, C., Uboweja, E., Hays, M.,
  Zhang, F., Chang, C.-L., Yong, M.G., Lee, J., Chang, W.-T., Hua, W., Georg, M.
  & Grundmann, M. (2019). MediaPipe: A Framework for Building Perception
  Pipelines. [arXiv:1906.08172](https://arxiv.org/abs/1906.08172) — the
  framework behind `FaceLandmarkReceiver`, `PoseReceiver`, and the face
  tracking that places the region of interest in `RPPGReceiver`.
- Rouast, P.V., Adam, M.T.P., Cornforth, D.J., Lux, E. & Weinhardt, C. (2016).
  Using Contactless Heart Rate Measurements for Real-Time Assessment of
  Affective States. In *Information Systems and Neuroscience*, LNISO 10,
  157–163.
  [doi:10.1007/978-3-319-41402-7_20](https://doi.org/10.1007/978-3-319-41402-7_20)
  — the green-channel rPPG approach of the original platform, implemented in
  [heartbeat-js](https://github.com/prouast/heartbeat-js).

Software this package builds on:

| Project | Used by |
|---|---|
| [muse-jsx](https://github.com/fuji3to4/muse-jsx) | `MuseReceiver` — Bluetooth GATT over Web Bluetooth |
| [Cortex API](https://emotiv.gitbook.io/cortex-api) | `EMOTIVReceiver` — proprietary, needs EMOTIV's local software |
| [MediaPipe Tasks](https://ai.google.dev/edge/mediapipe) | `FaceLandmarkReceiver`, `PoseReceiver`, `RPPGReceiver` |
| [face-api.js](https://github.com/justadudewhohacks/face-api.js) | `FaceEmotionReceiver`, via the maintained [`@vladmandic` fork](https://github.com/vladmandic/face-api) |
| [Lab Streaming Layer](https://labstreaminglayer.readthedocs.io) | `LSLReceiver`, through [LSLWebsocketMirror](https://github.com/esromerog/LSLWebsocketMirror) |
| [ml5.js](https://ml5js.org) | `VoiceEmotionReceiver` — model format; the forward pass is this package's |
| [formantanalyzer](https://github.com/tabahi/formantanalyzer.js) | `VoiceEmotionReceiver` — syllable segmentation and formant features |
