# Record and replay

`Recorder` writes a zip of CSVs that `FileReplayReceiver` reads back. Capture a
real session once and develop against it forever:

```ts
const recorder = new Recorder();
recorder.addReceiver(muse);
recorder.start();
// ...later
recorder.stop();
await recorder.download();     // yq_rec_20260814T1530.zip
```

```ts
const replay = new FileReplayReceiver({ loop: true, speed: 1 });
await replay.connect(zipFileOrURL);
replay.startStream();
replay.data.subscribe(handler);   // behaves exactly like the live device
```

Tracks recorded at different rates are advanced against one shared clock, so a
256 Hz EEG track and a 10 Hz feature track stay aligned during playback.

## Recording a pipeline

`Recorder` takes any `Observable<DataPacket>`, so it captures pipeline outputs
the same way it captures a device — `getOutput` works on **any** non-sink node,
intermediate or terminal, so you can tap wherever you want:

```ts
const recorder = new Recorder();
recorder.addReceiver(muse);                       // raw device, for replay
recorder.addSource(pipeline.getOutput("bands"));  // + a processed branch
recorder.start();
```

Recording is deliberately **not** a node and not wired into the graph's
execution — it is a side channel you start and stop by hand, and it can just as
well be attached after the fact. To capture what a graph puts out, feed the
recorder its [outputs](pipelines.md#outputs):

```ts
const recorder = new Recorder();
for (const output of pipeline.outputs.values()) recorder.addSource(output);
recorder.start();
```
