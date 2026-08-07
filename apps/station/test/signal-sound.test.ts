import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { loadSoundSettings, playSignalTone, saveSoundSettings } from "../src/lib/signal-sound.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const stmt of STATION_MIGRATIONS) {
    try {
      db.exec(stmt);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

function fakeAudio() {
  const gain = {
    gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  const osc = {
    frequency: { value: 0, setValueAtTime: vi.fn() },
    type: "",
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const ctx = {
    currentTime: 0,
    destination: {},
    state: "running",
    resume: vi.fn(() => Promise.resolve()),
    createGain: () => gain,
    createOscillator: () => osc,
    close: vi.fn(),
  } as unknown as AudioContext;
  return { ctx, gain, osc };
}

describe("sound settings", () => {
  it("defaults to unmuted at full volume when nothing is stored", async () => {
    expect(await loadSoundSettings(makeExec())).toEqual({ muted: false, volume: 1 });
  });

  it("round-trips saved settings", async () => {
    const exec = makeExec();
    await saveSoundSettings(exec, { muted: true, volume: 0.4 });
    expect(await loadSoundSettings(exec)).toEqual({ muted: true, volume: 0.4 });
  });

  it("falls back to defaults instead of rejecting when the read itself fails (e.g. a first-boot device where station_meta does not exist yet)", async () => {
    const exec: SqlExecutor = {
      run: async () => {},
      all: async () => {
        throw new Error("no such table: station_meta");
      },
    };
    await expect(loadSoundSettings(exec)).resolves.toEqual({ muted: false, volume: 1 });
  });
});

describe("signal tones", () => {
  it.each([
    ["ok", 880],
    ["error", 220],
    ["duplicate", 440],
  ] as const)("maps the %s verdict to its pinned %i Hz sound", (tone, expectedHz) => {
    const audio = fakeAudio();
    playSignalTone(tone, { muted: false, volume: 1 }, () => audio.ctx);

    expect(audio.osc.frequency.setValueAtTime).toHaveBeenCalledWith(expectedHz, 0);
    expect(audio.osc.start).toHaveBeenCalledOnce();
  });

  it("stays silent when muted", () => {
    const audio = fakeAudio();
    playSignalTone("ok", { muted: true, volume: 1 }, () => audio.ctx);
    expect(audio.osc.start).not.toHaveBeenCalled();
  });

  it("does not throw when WebAudio is unavailable", () => {
    expect(() => playSignalTone("ok", { muted: false, volume: 1 }, () => null)).not.toThrow();
  });

  it("constructs the underlying AudioContext only once across several tones, reusing it rather than recreating it per call", async () => {
    vi.resetModules();
    const audio = fakeAudio();
    // A real `function`, not an arrow: browsers' `AudioContext` is invoked
    // with `new`, and only a proper function (or class) can be constructed
    // that way — an arrow-based vi.fn() implementation would throw
    // "not a constructor" every time, which the module's own catch-all would
    // then silently swallow, masking the very bug this test exists to catch.
    const ctorSpy = vi.fn(function AudioContextStub() {
      return audio.ctx;
    });
    vi.stubGlobal("AudioContext", ctorSpy);
    try {
      const fresh = await import("../src/lib/signal-sound.js");
      fresh.playSignalTone("ok", { muted: false, volume: 1 });
      fresh.playSignalTone("error", { muted: false, volume: 1 });
      fresh.playSignalTone("duplicate", { muted: false, volume: 1 });

      // All three tones actually played (proving the cached context is
      // genuinely usable, not just returned and ignored)...
      expect(audio.osc.start).toHaveBeenCalledTimes(3);
      // ...yet the constructor behind it ran exactly once.
      expect(ctorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("resumes a suspended context but never throws or rejects unhandled when resume fails", () => {
    const audio = fakeAudio();
    (audio.ctx as unknown as { state: string }).state = "suspended";
    const resume = vi.fn(() => Promise.reject(new Error("resume failed")));
    (audio.ctx as unknown as { resume: () => Promise<void> }).resume = resume;

    expect(() => playSignalTone("ok", { muted: false, volume: 1 }, () => audio.ctx)).not.toThrow();
    expect(resume).toHaveBeenCalled();
    expect(audio.osc.start).toHaveBeenCalled();
  });
});
