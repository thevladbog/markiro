import type { SqlExecutor } from "./mirror.js";
import type { SignalTone } from "../ui/SignalOverlay.js";

export interface SoundSettings {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

const DEFAULTS: SoundSettings = { muted: false, volume: 1 };
const META_KEY = "sound_settings";

export async function loadSoundSettings(exec: SqlExecutor): Promise<SoundSettings> {
  const rows = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [META_KEY],
  );
  const raw = rows[0]?.value;
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      muted: typeof parsed.muted === "boolean" ? parsed.muted : DEFAULTS.muted,
      volume: typeof parsed.volume === "number" ? parsed.volume : DEFAULTS.volume,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSoundSettings(exec: SqlExecutor, s: SoundSettings): Promise<void> {
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [META_KEY, JSON.stringify(s)],
  );
}

/**
 * Frequency and duration per verdict. Synthesised rather than loaded: there
 * are no audio assets in this repo, fetching any would break the "no CDN
 * assets" rule, and distinct pitches are exactly what a noisy floor needs —
 * design brief 04 requires the sound alone to be sufficient when the operator
 * is watching the line rather than the screen.
 */
const TONES: Record<SignalTone, { hz: number; seconds: number; type: OscillatorType }> = {
  ok: { hz: 880, seconds: 0.12, type: "sine" },
  error: { hz: 220, seconds: 0.45, type: "square" },
  duplicate: { hz: 440, seconds: 0.3, type: "triangle" },
};

function defaultContext(): AudioContext | null {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  return Ctor ? new Ctor() : null;
}

/**
 * Fires one short tone. Never throws: a floor device with no working audio
 * output must keep validating codes (the visual flash alone is sufficient by
 * design), so every failure here is swallowed.
 */
export function playSignalTone(
  tone: SignalTone,
  settings: SoundSettings,
  ctxFactory: () => AudioContext | null = defaultContext,
): void {
  if (settings.muted || settings.volume <= 0) return;
  try {
    const ctx = ctxFactory();
    if (!ctx) return;
    const spec = TONES[tone];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.hz, ctx.currentTime);
    gain.gain.setValueAtTime(Math.min(1, Math.max(0, settings.volume)), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + spec.seconds);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + spec.seconds);
  } catch {
    // Audio is a bonus channel; the flash carries the verdict on its own.
  }
}
