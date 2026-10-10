import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { playSignalTone, TONES } from "../src/floor/work/signal-sound.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** Just enough of an `AudioContext` to see what tone was played. */
function fakeAudio(state: AudioContextState = "running") {
  const frequency = { setValueAtTime: vi.fn() };
  const oscillator = {
    type: "sine" as OscillatorType,
    frequency,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  const audio = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => undefined),
    createOscillator: () => oscillator,
    createGain: () => gain,
  };
  return { audio, oscillator, frequency };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the tone of a verdict", () => {
  it("plays each verdict at its own pitch and length", () => {
    for (const tone of ["ok", "duplicate", "error"] as const) {
      const { audio, oscillator, frequency } = fakeAudio();
      playSignalTone(tone, () => audio as unknown as AudioContext);
      expect(oscillator.type).toBe(TONES[tone].type);
      expect(frequency.setValueAtTime).toHaveBeenCalledWith(TONES[tone].hz, 10);
      expect(oscillator.stop).toHaveBeenCalledWith(10 + TONES[tone].seconds);
    }
    expect(new Set(Object.values(TONES).map((spec) => spec.hz)).size).toBe(3);
  });

  it("wakes a sleeping context and plays anyway", () => {
    const { audio, oscillator } = fakeAudio("suspended");
    playSignalTone("ok", () => audio as unknown as AudioContext);
    expect(audio.resume).toHaveBeenCalledTimes(1);
    expect(oscillator.start).toHaveBeenCalledTimes(1);
  });

  it("does not wake a context that is running", () => {
    const { audio } = fakeAudio("running");
    playSignalTone("ok", () => audio as unknown as AudioContext);
    expect(audio.resume).not.toHaveBeenCalled();
  });

  it("is silent, and throws nothing, without sound", () => {
    expect(() => playSignalTone("error", () => null)).not.toThrow();
    expect(() =>
      playSignalTone("error", () => {
        throw new Error("no audio device");
      }),
    ).not.toThrow();
    // jsdom has no `AudioContext` at all.
    expect(() => playSignalTone("ok")).not.toThrow();
  });

  it("holds one audio context for the page's life, not one per scan", async () => {
    const created = vi.fn();
    class OneContext {
      state: AudioContextState = "running";
      currentTime = 1;
      destination = {};
      constructor() {
        created();
      }
      resume = async () => undefined;
      createOscillator = () => fakeAudio().oscillator;
      createGain = () => ({
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      });
    }
    vi.stubGlobal("AudioContext", OneContext);
    // A fresh copy of the module, so the context another test cached is not in the way.
    vi.resetModules();
    const fresh = await import("../src/floor/work/signal-sound.js");
    fresh.playSignalTone("ok");
    fresh.playSignalTone("error");
    fresh.playSignalTone("duplicate");
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("loads no sound file and reaches for no network: the tones are generated", () => {
    // The station bundles its sounds and may be offline (an offline factory path).
    for (const file of ["signal-sound.ts", "WorkScreen.tsx"]) {
      const source = readFileSync(new URL(`../src/floor/work/${file}`, testModuleUrl), "utf8");
      expect(source, file).not.toMatch(/https?:\/\/|fetch\(|new Audio\(|\.(mp3|wav|ogg)\b/);
    }
  });
});
