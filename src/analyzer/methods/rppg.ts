/**
 * Remote photoplethysmography: turning the mean colour of a patch of skin into
 * a pulse waveform.
 *
 * A camera sees the pulse as a change in skin colour of well under 1%, and it
 * sees much larger changes from everything else: the light dimming, the head
 * turning, a highlight sliding across the forehead. Every method here works on
 * the colour *normalised by its own short-term mean*, which removes the skin's
 * tone and the light's brightness. The methods then differ in how they combine
 * the three channels.
 *
 * - `pos` — Plane-Orthogonal-to-Skin (Wang et al., 2017). Projects onto the
 *   plane orthogonal to the normalised skin tone, where a pure brightness
 *   change contributes nothing, then mixes the two projections by the ratio of
 *   their standard deviations to cancel the specular (motion) component left
 *   in the plane. The best-performing of the classical methods in the paper's
 *   own benchmark and in both toolboxes the field uses (pyVHR, rPPG-Toolbox).
 * - `green` — the green channel alone (Verkruysse et al., 2008), in the same
 *   normalised, windowed framing, so the two differ only in the projection.
 *   The baseline POS is measured against; it has no defence against a
 *   brightness change.
 *
 * Wang, W., den Brinker, A.C., Stuijk, S. & de Haan, G. (2017). Algorithmic
 * principles of remote PPG. IEEE Trans Biomed Eng 64(7):1479–1491.
 * https://doi.org/10.1109/TBME.2016.2609282
 *
 * Verkruysse, W., Svaasand, L.O. & Nelson, J.S. (2008). Remote
 * plethysmographic imaging using ambient light. Optics Express
 * 16(26):21434–21445. https://doi.org/10.1364/OE.16.021434
 */

export type PulseAlgorithm = "pos" | "green";

/**
 * Wang et al.'s projection, `P` in their Algorithm 1. Both rows are orthogonal
 * to [1, 1, 1], the direction a pure brightness change takes once each channel
 * is divided by its mean.
 */
export const POS_PROJECTION: readonly (readonly number[])[] = [
  [0, 1, -1],
  [-2, 1, 1],
];

/**
 * POS window length in frames for a duration in seconds.
 *
 * Rounded, so 1.6 s gives the paper's 32 frames at 20 fps and 48 at 30 fps.
 * pyVHR floors (`int(1.6 * fps)`) and rPPG-Toolbox takes the ceiling. All
 * three agree wherever 1.6 × fps is a whole number (15, 20, 25, 30 and
 * 60 fps), and differ by a frame at rates such as 24 or 29.97 fps.
 */
export function pulseWindowLength(seconds: number, samplingRate: number): number {
  return Math.max(2, Math.round(seconds * samplingRate));
}

/**
 * The pulse contribution of one window of colour samples, with its mean
 * removed: `h − mean(h)` in Wang et al.'s Algorithm 1.
 *
 * Reads `length` samples of each channel from `start`. Returns zeros when a
 * channel's mean is not positive (a black frame cannot be normalised).
 *
 * The sign is the paper's, which follows reflected light: more blood absorbs
 * more, so the waveform *dips* at each systole.
 */
export function pulseWindow(
  red: ArrayLike<number>,
  green: ArrayLike<number>,
  blue: ArrayLike<number>,
  algorithm: PulseAlgorithm = "pos",
  start = 0,
  length = green.length - start
): Float64Array {
  const h = new Float64Array(length);
  if (length <= 0) return h;

  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < length; i++) {
    mr += red[start + i];
    mg += green[start + i];
    mb += blue[start + i];
  }
  mr /= length;
  mg /= length;
  mb /= length;

  if (algorithm === "green") {
    if (!(mg > 0)) return h;
    let mean = 0;
    for (let i = 0; i < length; i++) {
      h[i] = green[start + i] / mg - 1;
      mean += h[i];
    }
    mean /= length;
    for (let i = 0; i < length; i++) h[i] -= mean;
    return h;
  }

  if (!(mr > 0 && mg > 0 && mb > 0)) return h;

  // S = P · Cn, one row at a time.
  const s1 = new Float64Array(length);
  const s2 = new Float64Array(length);
  let mean1 = 0;
  let mean2 = 0;
  for (let i = 0; i < length; i++) {
    const r = red[start + i] / mr;
    const g = green[start + i] / mg;
    const b = blue[start + i] / mb;
    s1[i] = g - b;
    s2[i] = -2 * r + g + b;
    mean1 += s1[i];
    mean2 += s2[i];
  }
  mean1 /= length;
  mean2 /= length;

  // Only the ratio of the two deviations is used, so ddof does not matter.
  let var1 = 0;
  let var2 = 0;
  for (let i = 0; i < length; i++) {
    var1 += (s1[i] - mean1) ** 2;
    var2 += (s2[i] - mean2) ** 2;
  }
  const alpha = var2 > 0 ? Math.sqrt(var1 / var2) : 0;

  let mean = 0;
  for (let i = 0; i < length; i++) {
    h[i] = s1[i] + alpha * s2[i];
    mean += h[i];
  }
  mean /= length;
  for (let i = 0; i < length; i++) h[i] -= mean;
  return h;
}

/**
 * Pulse extraction over a whole recording: Wang et al.'s Algorithm 1, which
 * overlap-adds {@link pulseWindow} over every window of `windowLength`
 * consecutive frames.
 *
 * The first and last `windowLength − 1` samples are covered by fewer windows
 * than the rest. Sign as in {@link pulseWindow}.
 */
export function extractPulse(
  red: ArrayLike<number>,
  green: ArrayLike<number>,
  blue: ArrayLike<number>,
  windowLength: number,
  algorithm: PulseAlgorithm = "pos"
): Float64Array {
  const n = green.length;
  const out = new Float64Array(n);
  for (let m = 0; m + windowLength <= n; m++) {
    const h = pulseWindow(red, green, blue, algorithm, m, windowLength);
    for (let j = 0; j < windowLength; j++) out[m + j] += h[j];
  }
  return out;
}
