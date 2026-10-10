import type { SignalTone } from "@markiro/ui";

/**
 * Pitch and length of each verdict's tone (the cloud station's
 * `signal-sound.ts`): generated, not loaded — the station has no audio
 * files and fetches nothing — and distinct enough that the sound alone tells
 * a duplicate from an error while the operator watches the line, not the
 * screen. The volume and muting of the workstation's setup are plan 2a7's.
 */
export const TONES: Record<SignalTone, { hz: number; seconds: number; type: OscillatorType }> = {
  ok: { hz: 880, seconds: 0.12, type: "sine" },
  error: { hz: 220, seconds: 0.45, type: "square" },
  duplicate: { hz: 440, seconds: 0.3, type: "triangle" },
};

/**
 * One context for the page's life: WebView2, like Chromium, caps the audio
 * contexts a page may hold, and a new one per scan would run out after a few
 * tones and fall silent.
 */
let cached: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (cached !== null) return cached;
  // jsdom, and a webview without sound, have no `AudioContext` at all.
  cached = typeof AudioContext === "undefined" ? null : new AudioContext();
  return cached;
}

/**
 * Plays a verdict's tone. Never throws: a station without working sound
 * keeps scanning, and the screen says the verdict in words and colour too.
 */
export function playSignalTone(
  tone: SignalTone,
  context: () => AudioContext | null = audioContext,
): void {
  try {
    const audio = context();
    if (audio === null) return;
    if (audio.state === "suspended") {
      // A kiosk's first touch may come after its first scan; resuming is
      // best effort, and the tone is tried anyway.
      audio.resume().catch(() => undefined);
    }
    const spec = TONES[tone];
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = spec.type;
    oscillator.frequency.setValueAtTime(spec.hz, audio.currentTime);
    gain.gain.setValueAtTime(1, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + spec.seconds);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + spec.seconds);
  } catch {
    // Sound is a second channel; the screen carries the verdict on its own.
  }
}
