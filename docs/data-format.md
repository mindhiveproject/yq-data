# Data format

We have one unified data packet type to be able to read through and transmit through the graph:

```ts
interface DataPacket {
  streamID: string;        // i.e. "muse-4B2C:eeg:features:band_power"
  timestamp: number;       // ms since epoch, host clock
  data: Float32Array;      // sample-interleaved flat array
  labels?: string[];       // categorical value per sample, mainly for marker streams
  metadata: StreamMetadata;
  deviceTime?: number;     // if available, the device's own clock
}
```

**Stream IDs** are `deviceID:modality:processingStage[:name]`. A mapping elsewhere in a graph needs only a stream ID and a channel index to identify any value.

**Payloads are sample-interleaved.** For a stream with `channelCount = C`, sample `i` of channel `c` lives at `data[i * C + c]`. This is the layout LSL, Web Audio and WAV already use, so most sources forward without a copy. You can use the helpers to get data:

```ts
import { getChannel, deinterleave, interleave } from "@mindhive_science/yq-data";

const af7 = getChannel(packet, 1);           // one dense channel
const all = deinterleave(packet.data, 4);    // every channel
const packed = interleave([left, right]);    // back to interleaved
```

**Metadata travels with the data.** `channelInfo` gives every channel a label and unit, and `processingHistory` accumulates a record of every analyzer a packet passed through.

**Almost every stream is numeric.** `labels` is the exception used for event markers and classifiers. A classifier can be a multi-channel packet whose classes are named by `channelInfo`.  A stream declares which it is with `metadata.valueType`, which is `"numeric"` unless it says otherwise and `"categorical"` when the value is the label and the number beside it only a code. Because it is declared on the stream, a graph can be checked before any data flows.
