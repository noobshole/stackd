/**
 * File-level provenance check: free, deterministic, run before Claude.
 *
 * AI image tools increasingly label what they make. OpenAI, Google, Adobe and
 * Microsoft write the IPTC digital source type `trainedAlgorithmicMedia` into
 * the file — as XMP, or inside a C2PA manifest — and desktop editors stamp
 * their name as the EXIF Software / XMP CreatorTool. A phone camera writes
 * neither. None of this survives a screenshot, so it only catches the lazy
 * fakes; Claude's visual judgement is still the main check.
 *
 * The raw bytes are searched instead of parsing each metadata format: every
 * marker is a long, case-exact ASCII string that cannot plausibly occur by
 * chance in compressed image data, and C2PA's CBOR keeps text strings as plain
 * UTF-8, so one scan covers JPEG, PNG and PDF alike.
 */

export type ProvenanceVerdict =
  | { ok: true }
  | { ok: false; kind: 'ai_generated' | 'edited'; marker: string; reason: string };

const AI_GENERATED: Array<[RegExp, string]> = [
  // IPTC digital source types, standalone or inside C2PA:
  // trainedAlgorithmicMedia, compositeWithTrainedAlgorithmicMedia, algorithmicMedia.
  [/[Aa]lgorithmicMedia/, 'IPTC digital source type: AI-generated'],
  [/compositeSynthetic/, 'IPTC digital source type: synthetic composite'],
  [/Made with Google AI/, 'Google AI label'],
  [/Midjourney/, 'Midjourney'],
  [/Stable Diffusion/, 'Stable Diffusion'],
  [/DALL-E/, 'DALL-E'],
  [/Adobe Firefly/, 'Adobe Firefly'],
];

/**
 * Desktop editors — nothing a genuine receipt photo passes through. Phone
 * crop/rotate tools stamp the OS instead ("iOS 19.1"), so they don't match.
 */
const EDITED: Array<[RegExp, string]> = [
  [/Adobe Photoshop/, 'Adobe Photoshop'],
  [/GIMP [23]\.\d/, 'GIMP'],
  [/Photopea/, 'Photopea'],
  [/Pixelmator/, 'Pixelmator'],
  [/Affinity Photo/, 'Affinity Photo'],
];

export function checkProvenance(file: Buffer): ProvenanceVerdict {
  // latin1 maps every byte to one char, so offsets and ASCII text survive intact.
  const bytes = file.toString('latin1');

  for (const [pattern, marker] of AI_GENERATED) {
    if (pattern.test(bytes)) {
      return {
        ok: false,
        kind: 'ai_generated',
        marker,
        reason: 'This image is labelled as AI-generated, so it cannot be accepted as a receipt.',
      };
    }
  }
  for (const [pattern, marker] of EDITED) {
    if (pattern.test(bytes)) {
      return {
        ok: false,
        kind: 'edited',
        marker,
        reason: `This image was saved from ${marker}. Upload the original photo of the receipt.`,
      };
    }
  }
  return { ok: true };
}
