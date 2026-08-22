import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, platformApiFetch } from "../src/api/client.js";
import { latestContractDiagnostic } from "../src/api/diagnostics.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "21111111-1111-4111-8111-111111111111";
const RELEASE_SHA = "release-abc123";
const responseSchema = z.object({ items: z.array(z.object({ createdAt: z.iso.datetime() })) });

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platform API client", () => {
  it("classifies fetch rejection as a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("token=do-not-retain"))),
    );

    await expect(
      platformApiFetch("/tenants?token=query-secret", { responseSchema }),
    ).rejects.toMatchObject({
      kind: "network",
      endpoint: "/tenants",
      status: null,
      code: null,
      requestId: null,
    });
  });

  it.each([
    [401, "authorization"],
    [403, "authorization"],
    [409, "domain"],
  ] as const)("classifies a valid %s platform envelope as %s", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          status,
          { code: "tenant_email_conflict", message: "Server wording", requestId: REQUEST_ID },
          { "x-request-id": REQUEST_ID },
        ),
      ),
    );

    const error = await platformApiFetch("/tenants", { responseSchema }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      kind,
      endpoint: "/tenants",
      status,
      code: "tenant_email_conflict",
      requestId: REQUEST_ID,
      issuePath: null,
    });
    expect((error as Error).message).not.toContain("Server wording");
  });

  it("reports the first issue path and only bounded safe diagnostics for malformed success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          200,
          { items: [{ createdAt: "2026-08-11 18:08:42.158", token: "do-not-store" }] },
          { "x-request-id": REQUEST_ID, "x-markiro-release-sha": RELEASE_SHA },
        ),
      ),
    );

    await expect(
      platformApiFetch("/tenants?token=query-secret", { responseSchema }),
    ).rejects.toMatchObject({
      kind: "contract",
      endpoint: "/tenants",
      issuePath: ["items", 0, "createdAt"],
      requestId: REQUEST_ID,
      releaseSha: RELEASE_SHA,
    });
    expect(latestContractDiagnostic()).toEqual({
      endpoint: "/tenants",
      issuePath: ["items", 0, "createdAt"],
      releaseSha: RELEASE_SHA,
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(latestContractDiagnostic())).not.toMatch(/query-secret|do-not-store/);
    expect(Object.keys(latestContractDiagnostic() ?? {}).sort()).toEqual([
      "endpoint",
      "issuePath",
      "releaseSha",
      "requestId",
    ]);
  });

  it("treats malformed non-2xx envelopes as contract failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          422,
          { code: "invalid", message: "missing request id", extra: "secret" },
          {
            "x-request-id": REQUEST_ID,
            "x-markiro-release-sha": RELEASE_SHA,
          },
        ),
      ),
    );

    await expect(platformApiFetch("/tenants", { responseSchema })).rejects.toMatchObject({
      kind: "contract",
      endpoint: "/tenants",
      status: 422,
      issuePath: ["requestId"],
      requestId: REQUEST_ID,
      releaseSha: RELEASE_SHA,
    });
  });

  it("rejects mismatched response-header and error-body request IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          409,
          { code: "conflict", message: "Conflict", requestId: OTHER_REQUEST_ID },
          { "x-request-id": REQUEST_ID },
        ),
      ),
    );

    await expect(platformApiFetch("/tenants", { responseSchema })).rejects.toMatchObject({
      kind: "contract",
      issuePath: ["requestId"],
      requestId: REQUEST_ID,
    });
  });
});
