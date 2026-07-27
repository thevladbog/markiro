import type { SqlExecutor } from "./mirror.js";
import type { SignalTone } from "../ui/SignalOverlay.js";

export interface SoundSettings {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

const DEFAULTS: SoundSettings = { muted: false, volume: 1 };
const META_KEY = "sound_settings";

/**
 * Never throws: on a genuinely fresh device this read races
 * `applyMigrations` for the same shared `dbPromise` (both are unconditional
 * effects in App.tsx, and this one is not gated on `config`/migrations
 * finishing), so `SELECT ... FROM station_meta` can be dispatched — and
 * reject with "no such table: station_meta" — before `CREATE TABLE IF NOT
 * EXISTS station_meta` runs. A transient lock or a malformed row are
 * equally harmless to lose. Sound settings are a preference, not data, so
 * defaulting is always safe — do not remove this guard.
 */
export async function loadSoundSettings(exec: SqlExecutor): Promise<SoundSettings> {
  let rows: { value: string | null }[];
  try {
    rows = await exec.all<{ value: string | null }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [META_KEY],
    );
  } catch {
    return { ...DEFAULTS };
  }
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

/**
 * Cached across calls: browsers cap concurrent hardware audio contexts
 * (Chromium enforces roughly six). A fresh `AudioContext` per scan would
 * exhaust that limit after a handful of tones, `new AudioContext()` would
 * then throw `NotSupportedError`, and `playSignalTone`'s catch-all below
 * would swallow it — silently losing the audio verdict design brief 04
 * requires to stand on its own when the operator is watching the line
 * rather than the screen. Do NOT "clean this up" by constructing a new
 * context per call; create it lazily once and reuse it for the page's
 * lifetime instead.
 */
let cachedContext: AudioContext | null = null;

function defaultContext(): AudioContext | null {
  if (cachedContext) return cachedContext;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  cachedContext = Ctor ? new Ctor() : null;
  return cachedContext;
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
    if (ctx.state === "suspended") {
      // Browsers start audio contexts suspended until a user gesture, and a
      // kiosk's first tap/click may land after the first scan is already
      // queued. Resuming is best-effort and inherently async: the tone
      // below is attempted regardless, and a rejection here must never
      // surface as an unhandled rejection or throw.
      ctx.resume().catch(() => {
        // Best-effort only; see comment above.
      });
    }
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
