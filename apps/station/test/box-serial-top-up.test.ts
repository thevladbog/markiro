import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../src/lib/mirror.js";
import { createBoxSerialTopUp } from "../src/lib/box-serial-top-up.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { addRange, burnSerial, remaining } from "../src/lib/sscc-pool.js";
import { StationApiError } from "../src/lib/api-client.js";
import { makeExec } from "./support/sqlite-exec.js";

const issuerPrefix = "460123456";
const oldBlock = {
  issuerPrefix,
  extensionDigit: 0,
  fromSerial: 1,
  toSerial: 2000,
  consumedThroughSerial: null,
};
const newBlock = {
  issuerPrefix,
  extensionDigit: 0,
  fromSerial: 2001,
  toSerial: 4000,
  consumedThroughSerial: null,
};

async function setup() {
  const exec = makeExec(new DatabaseSync(":memory:"));
  await applyMigrations(exec);
  return exec;
}

describe("box serial top-up", () => {
  it("checks the active issuer at low water, applies a grant, then burns the old range first", async () => {
    const exec = await setup();
    await addRange(exec, { ...oldBlock, consumedThroughSerial: 1600 });
    const post = vi.fn().mockResolvedValue({
      blocks: [{ ...oldBlock, consumedThroughSerial: 1600 }, newBlock],
      revokedFrom: [],
      issuerProblem: null,
    });
    const controller = createBoxSerialTopUp({
      client: { post },
      exec,
      shiftId: "shift-1",
      issuerPrefix,
      generation: createCredentialGeneration(),
      isCurrent: () => true,
    });
    await controller.nudge();
    expect(post).toHaveBeenCalledTimes(1);
    expect(await remaining(exec, issuerPrefix, 0)).toBe(2400);
    expect(await burnSerial(exec, issuerPrefix, 0)).toBe(1601);
    controller.stop();
  });

  it("does not make a request above 400 remaining", async () => {
    const exec = await setup();
    await addRange(exec, { ...oldBlock, consumedThroughSerial: 1599 });
    const post = vi.fn();
    const controller = createBoxSerialTopUp({
      client: { post },
      exec,
      shiftId: "shift-1",
      issuerPrefix,
      generation: createCredentialGeneration(),
      isCurrent: () => true,
    });
    await controller.nudge();
    expect(post).not.toHaveBeenCalled();
    controller.stop();
  });

  it("ignores a late response after the shift changes", async () => {
    const exec = await setup();
    let resolveResponse!: (value: unknown) => void;
    const post = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    let current = true;
    const controller = createBoxSerialTopUp({
      client: { post },
      exec,
      shiftId: "shift-1",
      issuerPrefix,
      generation: createCredentialGeneration(),
      isCurrent: () => current,
    });
    const pending = controller.nudge();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    current = false;
    resolveResponse({ blocks: [newBlock], revokedFrom: [], issuerProblem: null });
    await pending;
    expect(await remaining(exec, issuerPrefix, 0)).toBe(0);
    controller.stop();
  });

  it("stops contacting an older API after its first 404", async () => {
    const exec = await setup();
    const post = vi.fn().mockRejectedValue(new StationApiError(404, "Not found"));
    const controller = createBoxSerialTopUp({
      client: { post },
      exec,
      shiftId: "shift-1",
      issuerPrefix,
      generation: createCredentialGeneration(),
      isCurrent: () => true,
    });
    await controller.nudge();
    await controller.nudge();
    expect(post).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("keeps network backoff when another closure nudges a failed low-water check", async () => {
    const exec = await setup();
    const post = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const controller = createBoxSerialTopUp({
      client: { post },
      exec,
      shiftId: "shift-1",
      issuerPrefix,
      generation: createCredentialGeneration(),
      isCurrent: () => true,
    });
    await controller.nudge();
    await controller.nudge();
    expect(post).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("waits for an in-flight bundle mirror before applying a top-up response", async () => {
    const exec = await setup();
    let releaseBundle!: () => void;
    const bundleDone = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    const post = vi.fn().mockResolvedValue({
      blocks: [newBlock],
      revokedFrom: [],
      issuerProblem: null,
    });
    const controller = createBoxSerialTopUp({
      client: { post },
      exec,
      shiftId: "shift-1",
      issuerPrefix,
      generation: createCredentialGeneration(),
      isCurrent: () => true,
      waitForBundle: () => bundleDone,
    });
    const pending = controller.nudge();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(await remaining(exec, issuerPrefix, 0)).toBe(0);
    releaseBundle();
    await pending;
    expect(await remaining(exec, issuerPrefix, 0)).toBe(2000);
    controller.stop();
  });
});
