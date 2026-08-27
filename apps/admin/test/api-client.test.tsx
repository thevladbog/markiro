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
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
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

/**
 * Faithful model of a real fetch `Response` whose body is EMPTY: undici's
 * `json()` rejects with a SyntaxError, `text()` resolves to `""`. This is
 * exactly what every Nest void handler answers (200, content-length: 0 --
 * verified against the running API: `DELETE /integrations/public_api/keys/:id`,
 * `DELETE /products/:id/external-link`), and what the file-local
 * `jsonResponse` stand-ins above can never produce -- their `json()` always
 * resolves, which is why the page tests kept passing while the real success
 * path threw.
 */
function emptyBodyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
    text: async () => "",
  } as unknown as Response;
}

describe("apiFetch empty success bodies", () => {
  // Регрессия: `apiFetch` раньше звал `response.json()` на всём, кроме 204,
  // и успешная void-мутация (revoke ключа, разрыв external-link, link/hide
  // кандидата) падала УЖЕ НА КЛИЕНТЕ -- после того как сервер её выполнил.
  it("resolves undefined for a 200 with an empty body (Nest void handler)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => emptyBodyResponse(200)),
    );

    await expect(apiFetch<void>("/integrations/public_api/keys/k1")).resolves.toBeUndefined();
  });

  it("still resolves undefined for a 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => emptyBodyResponse(204)),
    );

    await expect(apiFetch<void>("/integrations/commerceml")).resolves.toBeUndefined();
  });

  it("still parses a non-empty JSON success body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: "",
            json: async () => {
              throw new Error("apiFetch must not depend on json() for success bodies");
            },
            text: async () => JSON.stringify({ keys: [{ id: "k1" }] }),
          }) as unknown as Response,
      ),
    );

    await expect(apiFetch("/integrations/public_api/keys")).resolves.toEqual({
      keys: [{ id: "k1" }],
    });
  });
});
