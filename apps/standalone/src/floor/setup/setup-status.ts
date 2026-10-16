import {
  PRINT_PURPOSES,
  soundLevel,
  type PrintPurpose,
  type WorkstationSettings,
} from "./workstation-settings.js";

/** What differs between the stored settings and the draft: the words of «Не сохранено: …». */
export type UnsavedPart =
  "printers" | `assignment_${PrintPurpose}` | "verify" | "scanners" | "sound" | "volume";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The parts of the setup that are changed and not yet stored, in the order the screen shows them:
 * the printers, who prints what, the label check, the scanners, the sound switch, the volume.
 * Empty when the draft is what is stored.
 */
export function unsavedParts(
  stored: WorkstationSettings,
  draft: WorkstationSettings,
): UnsavedPart[] {
  const parts: UnsavedPart[] = [];
  if (!same(stored.printers, draft.printers)) parts.push("printers");
  for (const purpose of PRINT_PURPOSES) {
    if (stored.assignments[purpose] !== draft.assignments[purpose]) {
      parts.push(`assignment_${purpose}`);
    }
  }
  if (stored.verifyPrintedLabel !== draft.verifyPrintedLabel) parts.push("verify");
  if (!same(stored.scanners, draft.scanners)) parts.push("scanners");
  if (stored.sound.muted !== draft.sound.muted) parts.push("sound");
  if (stored.sound.volume !== draft.sound.volume) parts.push("volume");
  return parts;
}

/** The ten-division scale of the volume: how many divisions are filled (0 when silent). */
export function volumeDivisions(sound: WorkstationSettings["sound"]): number {
  return Math.round(soundLevel(sound) * 10);
}
