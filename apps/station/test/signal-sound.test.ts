import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db";
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
});

describe("signal tones", () => {
  it("plays a distinct frequency per verdict", () => {
    const ok = fakeAudio();
    playSignalTone("ok", { muted: false, volume: 1 }, () => ok.ctx);
    const err = fakeAudio();
    playSignalTone("error", { muted: false, volume: 1 }, () => err.ctx);

    expect(ok.osc.start).toHaveBeenCalled();
    expect(err.osc.start).toHaveBeenCalled();
    expect(ok.osc.frequency.setValueAtTime).not.toHaveBeenCalledWith(
      err.osc.frequency.setValueAtTime.mock.calls[0]![0],
      expect.anything(),
    );
  });

  it("stays silent when muted", () => {
    const audio = fakeAudio();
    playSignalTone("ok", { muted: true, volume: 1 }, () => audio.ctx);
    expect(audio.osc.start).not.toHaveBeenCalled();
  });

  it("does not throw when WebAudio is unavailable", () => {
    expect(() => playSignalTone("ok", { muted: false, volume: 1 }, () => null)).not.toThrow();
  });
});
