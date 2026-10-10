import { describe, expect, it, vi } from "vitest";

import { createSystemAwake } from "../src/hardware/awake.js";
import type { HardwareApi } from "../src/hardware/hardware.js";

/** A shell whose power requests the test answers one by one. */
function heldPower() {
  const calls: { awake: boolean; answer: (error?: Error) => void }[] = [];
  const setSystemAwake = vi.fn<HardwareApi["setSystemAwake"]>(
    (awake) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ awake, answer: (error) => (error ? reject(error) : resolve()) });
      }),
  );
  return { setSystemAwake, calls };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("keeping the computer awake", () => {
  it("asks once for the first hold and lets go after the last release", async () => {
    const setSystemAwake = vi.fn<HardwareApi["setSystemAwake"]>(async () => undefined);
    const awake = createSystemAwake(setSystemAwake);
    const first = awake.hold();
    const second = awake.hold();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true]]);
    first();
    first();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true]]);
    second();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false]]);
  });

  it("asks in the order the screens did, one request at a time", async () => {
    const power = heldPower();
    const awake = createSystemAwake(power.setSystemAwake);
    awake.hold()();
    awake.hold();
    await flush();
    // The release and the next hold wait for the first request's answer.
    expect(power.calls.map((call) => call.awake)).toEqual([true]);
    power.calls[0]?.answer();
    await flush();
    expect(power.calls.map((call) => call.awake)).toEqual([true, false]);
    power.calls[1]?.answer(new Error("power_request_failed"));
    await flush();
    // A refusal does not stop the next request.
    expect(power.calls.map((call) => call.awake)).toEqual([true, false, true]);
  });

  it("lets go at the app's start whatever a reloaded webview held, and a later release asks nothing", async () => {
    const setSystemAwake = vi.fn<HardwareApi["setSystemAwake"]>(async () => undefined);
    const awake = createSystemAwake(setSystemAwake);
    const release = awake.hold();
    await awake.reset();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false]]);
    release();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false]]);
    const next = awake.hold();
    // The hold from before the reset lets go of nothing the new one holds.
    release();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false], [true]]);
    next();
    await flush();
    expect(setSystemAwake.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("never rejects, even when the shell refuses", async () => {
    const awake = createSystemAwake(async () => {
      throw new Error("power_request_failed");
    });
    await expect(awake.reset()).resolves.toBeUndefined();
    expect(() => awake.hold()()).not.toThrow();
  });
});
