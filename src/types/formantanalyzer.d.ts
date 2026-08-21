/**
 * `formantanalyzer` ships no type declarations, so this describes the small
 * surface {@link VoiceEmotionReceiver} uses. It is deliberately not exhaustive
 * — the library exposes plotting and file-playback entry points this package
 * has no use for.
 *
 * This is an ambient declaration rather than a module augmentation, since
 * there are no upstream types to augment. It names the bundle path rather
 * than the bare specifier for the reason given in `voice_emotion.ts`.
 */
declare module "formantanalyzer/index.js" {
  /** Settings for the spectrum, segmentation and feature stages. */
  export function configure(config: Record<string, unknown>): void;

  /**
   * Starts an audio source and calls back once per finished segment.
   *
   * Resolves when playback ends or {@link StopAudioNodes} is called.
   *
   * @param contextSource 1 = local file binary, 2 = Audio element, 3 = microphone.
   * @param sourceObj The source for modes 1 and 2; `null` for the microphone.
   * @param callback Receives `(segmentIndex, labels, times, features)`, where
   * `times` is `[startMs, durationMs]` per unit and the shape of `features`
   * depends on the configured `output_level`.
   */
  export function LaunchAudioNodes(
    contextSource: number,
    sourceObj: unknown,
    callback:
      | ((
          segmentIndex: number,
          labels: unknown[],
          times: number[][],
          features: number[][]
        ) => void)
      | null,
    label?: unknown[],
    offlineMode?: boolean,
    testPlay?: boolean,
    playOffset?: number | null,
    playDuration?: number | null
  ): Promise<unknown>;

  /** Stops the running audio nodes, resolving the launch promise. */
  export function StopAudioNodes(reason?: string): void;
}
