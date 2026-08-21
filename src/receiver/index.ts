/**
 * Receiver module exports
 */

// Export base receiver
export { BaseReceiver } from "./base_receiver";
export type { PacketOptions } from "./base_receiver";

// Hardware devices
export * from "./devices/muse";
export * from "./devices/emotiv";

// Media inputs
export * from "./devices/video";
export * from "./devices/audio";

// Network and file sources
export * from "./devices/lsl";
export * from "./devices/file_replay";

// Timed events pushed in from surrounding code (an experiment, a UI).
export * from "./devices/marker";

// Camera-derived signals. These require the optional @mediapipe/tasks-vision
// peer dependency, which is loaded lazily on connect.
export * from "./devices/vision/base_vision";
export * from "./devices/vision/face_landmarker";
export * from "./devices/vision/pose";
export * from "./devices/vision/rppg";

// Facial emotion recognition. Requires the optional @vladmandic/face-api peer
// dependency, which is loaded lazily on connect.
export * from "./devices/vision/face_emotion";

// Speech emotion recognition. Requires the optional formantanalyzer peer
// dependency, which is loaded lazily on connect.
export * from "./devices/voice/voice_emotion";
export * from "./devices/voice/ml5_model";
