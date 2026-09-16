import { renderHook, waitFor } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { useDeviceReplacement } from "../src/lib/use-device-replacement.js";
import {
  prepareReplacementReadiness,
  drainReplacementReadiness,
  readReplacementDrain,
} from "../src/lib/device-replacement.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { makeExec } from "./support/sqlite-exec.js";
import type { StationClient } from "../src/lib/api-client.js";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const intent = {
  intentId: "11111111-1111-4111-8111-111111111111",
  preparationId: "22222222-2222-4222-8222-222222222222",
  credentialEpoch: 1,
  preparationRevision: 2,
  requestedAt: "2026-09-16T10:00:00Z",
  expiresAt: "2026-09-16T10:05:00Z",
};
async function fixture(response: unknown) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
  }
  const exec = makeExec(db),
    generation = createCredentialGeneration("test-device");
  const expectedDevice = { tenantId: "tenant", deviceId: "device" };
  await prepareReplacementReadiness({ exec, generation, expectedDevice, intent });
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path.endsWith("/acknowledge"))
      return { ...(body as object), acknowledgedAt: "2026-09-16T10:03:00Z" };
    const report = body as { requestId: string; intentId: string };
    return {
      requestId: report.requestId,
      intentId: report.intentId,
      receivedAt: "2026-09-16T10:01:00Z",
      unsupportedChannels: [],
      eligibility: { status: "eligible", reasons: [] },
    };
  });
  const get = vi.fn(async () => response);
  const client: StationClient = {
    async get<T>() {
      return (await get()) as T;
    },
    async post<T>(path: string, body?: unknown) {
      return (await post(path, body)) as T;
    },
    async download() {
      return new Blob();
    },
    async whoami() {
      return { ok: true };
    },
  };
  const input = {
    exec,
    generation,
    client,
    expectedDevice,
    clientBuild: async () => "station:test",
    activeTask: null,
    onDrain: vi.fn(),
    onCancelled: vi.fn(),
  };
  return { db, input, post, get };
}
describe("replacement polling lifecycle", () => {
  it.each([null, { version: 1, state: "none" }])(
    "does not reopen a retained drain on an absent or delayed empty projection: %j",
    async (response) => {
      const f = await fixture(response);
      let release: (response: unknown) => void = () => {
        throw new Error("projection not requested");
      };
      f.get.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const rendered = renderHook(() => useDeviceReplacement(f.input));
      await waitFor(() => expect(rendered.result.current.loaded).toBe(true));
      await waitFor(() => expect(f.get).toHaveBeenCalledOnce());
      expect(rendered.result.current.drain?.intentId).toBe(intent.intentId);
      release(response);
      if (response === null)
        await waitFor(() => expect(rendered.result.current.drain?.reportFailed).toBe(true));
      else await waitFor(() => expect(f.post).toHaveBeenCalled());
      expect(rendered.result.current.drain?.intentId).toBe(intent.intentId);
      expect((await readReplacementDrain(f.input.exec))?.state).toBe("draining");
      expect(f.input.onCancelled).not.toHaveBeenCalled();
      rendered.unmount();
    },
  );
  it.each([false, true])(
    "acknowledges cancellation despite a rejected pending report: %s",
    async (rejectPendingReport) => {
      const f = await fixture({
        version: 1,
        state: "cancelled",
        intentId: intent.intentId,
        preparationId: intent.preparationId,
        credentialEpoch: 1,
        preparationRevision: 3,
        closedAt: "2026-09-16T10:02:00Z",
      });
      if (rejectPendingReport) {
        await drainReplacementReadiness({ ...f.input, clientBuild: "station:test" });
        f.post.mockRejectedValueOnce(new Error("intent already cancelled"));
      }
      const rendered = renderHook(() => useDeviceReplacement(f.input));
      await waitFor(() => expect(f.input.onCancelled).toHaveBeenCalledOnce());
      await waitFor(() => expect(rendered.result.current.drain).toBeNull());
      expect((await readReplacementDrain(f.input.exec))?.closure_acknowledged_at).toBe(
        "2026-09-16T10:03:00.000Z",
      );
      rendered.unmount();
    },
  );
});
