# Camera receivers

`VideoReceiver`, `FaceLandmarkReceiver`, `FaceEmotionReceiver`, `PoseReceiver` and `RPPGReceiver` all read from one camera.

## One camera, several analyses

`VideoReceiver` owns the camera and the `<video>` element; the vision receivers
read pixels from that same element. This is why face tracking and heart rate can
run together without opening the camera twice:

```ts
const camera = new VideoReceiver(videoElement);
await camera.connect();
await camera.startStream();

const face = new FaceLandmarkReceiver(videoElement);
const emotion = new FaceEmotionReceiver(videoElement);
const pulse = new RPPGReceiver(videoElement, { faceSource: face });
```

`faceSource` lets the pulse reuse the face tracker's landmarks instead of
running the same model a second time; without it, `RPPGReceiver` runs its own.

The element must stay mounted while streaming. In a React app, mount it once
outside the panel tree and portal previews into it — unmounting it when a tab
changes kills the camera and every derived stream.

## Heart rate from a camera

Each heartbeat changes the colour of the skin by a fraction of a percent.
`RPPGReceiver` measures that colour: every frame it averages the forehead and
both cheeks, drawn as polygons on the face mesh so they follow the head and
leave out the eyes, brows, nostrils and background. Its stream is three
channels (red, green, blue) at a fixed `samplingRate`. Frames are interpolated
onto that rate, so a camera that slows down in dim light still yields an even
stream.

The rest is a pipeline, and after `pulse` it is the same one a Muse PPG sensor
uses:

```ts
nodes: [
  { id: "rgb",    receiver: "rppg" },
  { id: "pulse",  method: AnalysisMethod.PULSE_EXTRACTION },
  { id: "window", method: AnalysisMethod.WINDOWING,  parameters: { size: 10, hop: 1 } },
  { id: "bpm",    method: AnalysisMethod.HEART_RATE },
]
```

`PulseExtraction` uses POS (Wang et al., 2017) by default. It divides each
channel by its mean over a sliding 1.6 s window, then projects onto the plane
orthogonal to the skin's colour. A change in brightness moves all three
channels together and vanishes in that plane, while the pulse, which is
strongest in green, does not. This is what keeps the rate right when the light
flickers or the head moves. Its output is a `ppg` stream named `pulse`, 1.6 s
behind the camera, with each systole a peak. It matches the paper's algorithm
to float precision, and pyVHR and rPPG-Toolbox too, in the golden suite.

POS has one cost. It mixes three channels, so it carries three channels' sensor
noise. For a still subject in steady light on a noisy camera, especially at
15 fps, `algorithm: "green"` (the green channel alone) has the better
signal-to-noise ratio.

When the face is lost for longer than `maxGap` (0.25 s), the stream goes
silent and restarts when the face returns. Its packets carry a sample clock
(`additionalMetadata.sampleClock`), so `PulseExtraction` and `Windowing` see
the missing time and start again rather than join the two sides. The rate then
returns once a full window has refilled.

## Drawing faces

`FaceOverlay` draws face streams onto a canvas laid over the video: the face
box, landmarks (as points, or joined by the model's contours or full mesh), head
pose as three axes, and the leading expression as a label.

```ts
const face = new FaceLandmarkReceiver(video, { emitFaceBox: true, emitLandmarks: true });

const overlay = new FaceOverlay(canvas, { video, layers: { connections: "contours" } });
overlay.attach(face);   // or overlay.push(packet) from a pipeline output
overlay.start();
```

It reads **streams**, not receivers, so the same code draws a local tracker and
one arriving from another machine through a `RemoteStreamReceiver`. The geometry
has to be switched on at the source (`emitFaceBox`, `emitLandmarks`,
`emitHeadPose`); the mesh's edges never travel with the data, because a stream
names its model (`topology`) and the overlay looks the edges up. Points are
normalised to the video frame, and the canvas should cover the video exactly:
the overlay applies the video's `object-fit`. Pass `mirror: true` for a video
flipped with CSS, rather than flipping the canvas too, which would mirror the
label text.

`PoseReceiver`'s `landmarks` stream is a point stream of the same kind, so the
overlay joins it into MediaPipe's skeleton. Streams in `worldCoordinates` are
metric rather than positions in the frame, declare `coordinateSpace: "world"`,
and are not drawn.

Face and body landmarks are described and read by the same helpers:
`pointStreamMetadata` (stride, `topology`, `coordinateSpace`), `streamPoints`
(a name and packet indices per point, e.g. `"left wrist"`), `pointStride`,
`pointBounds`, and `topologyEdges` / `topologyPointNames` for what the model
fixes. Multi-subject streams are named `landmarks_face_2` / `landmarks_pose_2`.

`pipeline.describe()` uses the same helper: for a point stream, each output
lists every value in `channels` (`"left wrist x"`, `"left wrist y"`, …, as
`channelCount` and `ChannelSelection` count them) and adds `points`, which
gathers those same indices by point (`{ label: "left wrist", indices: [48, 49, 50] }`),
so a node editor can list landmarks without knowing the stream is one.

A receiver publishes nothing for a frame with no face. That silence is how a
face leaving the frame reaches the canvas: it is cleared once its streams have
been quiet for `staleAfter` (by default four of the stream's own packet
intervals, the same rule as the pipeline's `maxAge`).
