import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivationFileError,
  confirmStandaloneLicense,
  downloadStandaloneLicense,
  getStandaloneSites,
  readActivationRequestFile,
} from "../src/pages/tenants/standalone-api.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { jsonResponse } from "./render.js";
import {
  STANDALONE_FILE,
  STANDALONE_LICENSE_ID,
  STANDALONE_PREVIEW,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
  STANDALONE_TENANT_ID,
} from "./standalone-fixtures.js";

// Vitest runs from apps/saas-admin; jsdom's import.meta.url is not a file URL.
const activationText = readFileSync(
  "../../packages/domain/fixtures/standalone-license/activation-request.json",
  "utf8",
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("standalone license API client (plan ЛЦ-0)", () => {
  it("calls the tenant's standalone-site routes with validated bodies", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        calls.push({
          method,
          url,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        });
        if (url.endsWith("/standalone-sites")) return jsonResponse(200, STANDALONE_SITE_LIST);
        return jsonResponse(200, STANDALONE_FILE);
      }),
    );
    await expect(getStandaloneSites(STANDALONE_TENANT_ID)).resolves.toEqual(STANDALONE_SITE_LIST);
    const body = {
      requestId: "f1111111-1111-4111-8111-111111111111",
      graceDays: null,
      offline: null,
      expected: STANDALONE_PREVIEW.expected,
    };
    await expect(
      confirmStandaloneLicense(STANDALONE_TENANT_ID, STANDALONE_SITE_ID, body),
    ).resolves.toEqual(STANDALONE_FILE);
    await expect(
      downloadStandaloneLicense(STANDALONE_TENANT_ID, STANDALONE_SITE_ID, STANDALONE_LICENSE_ID),
    ).resolves.toEqual(STANDALONE_FILE);
    const base = `/api/platform/tenants/${STANDALONE_TENANT_ID}/standalone-sites`;
    expect(calls).toEqual([
      { method: "GET", url: base, body: null },
      { method: "POST", url: `${base}/${STANDALONE_SITE_ID}/issuances`, body },
      {
        method: "GET",
        url: `${base}/${STANDALONE_SITE_ID}/issuances/${STANDALONE_LICENSE_ID}/file`,
        body: null,
      },
    ]);
  });

  it("reads an activation request file and refuses big, non-JSON and foreign files", async () => {
    await expect(
      readActivationRequestFile(new Blob([activationText], { type: "application/json" })),
    ).resolves.toMatchObject({ format: "markiro-activation-request-v1" });
    for (const [content, reason] of [
      ["x".repeat(64 * 1024 + 1), "too_large"],
      ["{not json", "not_json"],
      [JSON.stringify({ format: "something-else" }), "invalid"],
    ] as const) {
      const error = await readActivationRequestFile(new Blob([content])).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ActivationFileError);
      expect(error instanceof ActivationFileError ? error.reason : null).toBe(reason);
    }
  });

  it("saves the signed line as a .mklic download and releases the object URL", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_object: Blob | MediaSource) => "blob:license");
    const revokeObjectURL = vi.fn((_url: string) => undefined);
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        expect(this.download).toBe(STANDALONE_FILE.fileName);
        expect(this.href).toBe("blob:license");
      });
      saveLicenseFile(STANDALONE_FILE.fileName, STANDALONE_FILE.compact);
      expect(click).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect(blob instanceof Blob ? await blob.text() : null).toBe(STANDALONE_FILE.compact);
      expect(document.querySelector("a[download]")).toBeNull();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:license");
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
  });
});
