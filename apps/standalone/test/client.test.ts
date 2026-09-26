import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTauriHostClient, HostError, TRANSPORT_CODES } from "../src/host/client.js";

const valueSchema = z.object({ value: z.number() });

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HostError);
  return error as HostError;
}

describe("Tauri host client", () => {
  it("sends the request through host_request and parses a 2xx body", async () => {
    const call = vi.fn().mockResolvedValue({ status: 200, body: { value: 7 } });
    const result = await createTauriHostClient(call).request("PUT", "/v1/office/org", {
      body: { name: "ООО" },
      officeToken: "token",
      schema: valueSchema,
    });
    expect(result).toEqual({ value: 7 });
    expect(call).toHaveBeenCalledWith("host_request", {
      method: "PUT",
      path: "/v1/office/org",
      body: { name: "ООО" },
      officeToken: "token",
    });
  });

  it("sends null for an absent body and token and accepts an empty 204", async () => {
    const call = vi.fn().mockResolvedValue({ status: 204, body: null });
    await expect(
      createTauriHostClient(call).request("POST", "/v1/office/logout", { schema: z.null() }),
    ).resolves.toBeNull();
    expect(call).toHaveBeenCalledWith("host_request", {
      method: "POST",
      path: "/v1/office/logout",
      body: null,
      officeToken: null,
    });
  });

  it("turns an error body into an api error naming the credential", async () => {
    const call = vi.fn().mockResolvedValue({
      status: 401,
      body: {
        error: {
          code: "unauthorized",
          message: "office session expired",
          details: { credential: "session" },
        },
      },
    });
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/office/me", { schema: z.unknown() }),
    );
    expect(error.kind).toBe("api");
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.credential).toBe("session");
    expect(error.field).toBeNull();
  });

  it("names the field of a validation error", async () => {
    const call = vi.fn().mockResolvedValue({
      status: 400,
      body: { error: { code: "validation_failed", message: "bad", details: { field: "org.gln" } } },
    });
    const error = await failure(
      createTauriHostClient(call).request("POST", "/v1/bootstrap", { schema: z.unknown() }),
    );
    expect(error.field).toBe("org.gln");
    expect(error.credential).toBeNull();
  });

  it.each(TRANSPORT_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/device", { schema: z.unknown() }),
    );
    expect(error.kind).toBe("transport");
    expect(error.code).toBe(code);
    expect(error.status).toBeNull();
  });

  it("treats an unexpected shell error as unreachable", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/device", { schema: z.unknown() }),
    );
    expect(error.code).toBe("unreachable");
  });

  it.each([
    ["a 2xx body the schema rejects", { status: 200, body: { value: "seven" } }],
    ["an error status without an error body", { status: 500, body: null }],
    ["a malformed shell answer", { status: 200 }],
  ])("reports %s as an invalid response", async (_case, answer) => {
    const call = vi.fn().mockResolvedValue(answer);
    const error = await failure(
      createTauriHostClient(call).request("GET", "/v1/device", { schema: valueSchema }),
    );
    expect(error.kind).toBe("transport");
    expect(error.code).toBe("invalid_response");
  });
});
