// DataStream interface that defines what data streams look like
export interface DataStream<DataType = number[]> { 
    modality: Modality,
    timestamp: number,
    data: DataType,
    metadata: StreamMetadata,
}

// Type for Device Metadata
export type StreamMetadata = { 
    channelNames: string[],
    samplingRate: number,
    device: string,
    deviceID: string | number,
    isConnected?: boolean,
    additionalInfo?: string,
}
    // Could also include timeOffset and serverTime

// Enum of available modalities
export enum Modality {
    EEG = "eeg",
    PPG = "ppg",
    Video = "video_stream",
    Audio = "audio",
    ACC = "acc",
    EventMarker = "event_marker"
}
