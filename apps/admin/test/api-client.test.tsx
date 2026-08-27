import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch, ApiRequestError } from "../src/api/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

describe("apiFetch error message parsing", () => {
  it("retains the parsed response body for structured conflict handling", async () => {
    const body = { code: "INVENTORY_CLOSE_BLOCKED", blockers: [{ code: "VOIDED" }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, body)),
    );

    const error = await apiFetch("/inventories/1/close").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).details).toEqual(body);
  });

  it("uses a string `message` body field as-is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { message: "Counterparty is referenced" })),
    );

    await expect(apiFetch("/counterparties/1")).rejects.toMatchObject(
      new ApiRequestError(409, "Counterparty is referenced"),
    );
  });

  it("joins a `message` array of plain strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { message: ["a", "b"] })),
    );

    await expect(apiFetch("/counterparties")).rejects.toMatchObject(
      new ApiRequestError(400, "a, b"),
    );
  });

  it("joins a `message` array of ZodValidationPipe-style `{ path, message }` issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          message: [
            { path: "gln", message: "GLN check digit is invalid" },
            { path: "name", message: "name must be 1-200 characters" },
          ],
        }),
      ),
    );

    await expect(apiFetch("/counterparties")).rejects.toMatchObject(
      new ApiRequestError(400, "GLN check digit is invalid, name must be 1-200 characters"),
    );
  });

  it.each([{ message: "" }, { message: [] }])(
    "falls back when the parsed message is empty: %j",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(400, body)),
      );

      await expect(apiFetch("/counterparties")).rejects.toMatchObject(
        new ApiRequestError(400, "HTTP 400"),
      );
    },
  );
});
