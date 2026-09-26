import { describe, expect, it } from "vitest";

import { HostError, TRANSPORT_CODES } from "../src/host/client.js";
import { DEVICE_ERROR_CODES, DeviceError } from "../src/host/device.js";
import { API_ERROR_CODES, errorMessageKey } from "../src/host/errors.js";
import i18n from "../src/i18n/index.js";

function apiError(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 400, message: code, details });
}

describe("error messages", () => {
  it("have a text for every code the shell and the host send", () => {
    const keys = [
      ...TRANSPORT_CODES.map((code) =>
        errorMessageKey(new HostError({ kind: "transport", code, message: code })),
      ),
      ...API_ERROR_CODES.map((code) => errorMessageKey(apiError(code))),
      ...(["device", "session", "password"] as const).map((credential) =>
        errorMessageKey(apiError("unauthorized", { credential })),
      ),
      ...DEVICE_ERROR_CODES.map((code) => errorMessageKey(new DeviceError(code, code))),
    ];
    for (const key of keys) {
      expect(i18n.exists(key), key).toBe(true);
    }
  });

  it("prefer the rejected credential for unauthorized answers", () => {
    expect(errorMessageKey(apiError("unauthorized", { credential: "password" }))).toBe(
      "errors.unauthorized.password",
    );
    expect(errorMessageKey(apiError("unauthorized"))).toBe("errors.api.unauthorized");
  });

  it("fall back to a generic text for anything unknown", () => {
    expect(errorMessageKey(apiError("from_a_newer_host"))).toBe("errors.unknown");
    expect(errorMessageKey(new Error("boom"))).toBe("errors.unknown");
    expect(errorMessageKey("boom")).toBe("errors.unknown");
  });
});
