import { describe, expect, it } from "vitest";
import { HostError } from "../src/host/client.js";
import {
  YANDEX_ACTION_ERRORS,
  YANDEX_HOST_REASONS,
  yandexErrorCode,
} from "../src/host/yandex-errors.js";
import i18n from "../src/i18n/index.js";

const hostFailure = (reason: unknown, constraint: unknown = "yandex_backup") =>
  new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "private fixture message",
    details: { constraint, reason },
  });

describe("Yandex failure reasons at the UI boundary", () => {
  it.each(YANDEX_HOST_REASONS)("preserves the Host's public reason %s", (code) => {
    expect(yandexErrorCode(hostFailure(code))).toBe(code);
  });

  it.each([
    "private fixture value",
    "secret_prompt_failed",
    42,
    null,
    undefined,
    { remote_conflict: null },
  ])("refuses unrecognized or native-only Host reasons (%#)", (reason) => {
    expect(yandexErrorCode(hostFailure(reason))).toBe("host_operation_failed");
  });

  it("does not reinterpret another API conflict as a Yandex file conflict", () => {
    expect(yandexErrorCode(hostFailure("remote_conflict", "other"))).toBe("host_operation_failed");
  });

  it.each([
    ["session", "office_session_expired"],
    ["device", "device_not_authorized"],
  ])("keeps the rejected %s credential distinct", (credential, expected) => {
    expect(
      yandexErrorCode(
        new HostError({
          kind: "api",
          code: "unauthorized",
          status: 401,
          message: "fixture",
          details: { credential },
        }),
      ),
    ).toBe(expected);
  });

  it("distinguishes a Host outage and refusal from a Yandex outage", () => {
    expect(
      yandexErrorCode(
        new HostError({ kind: "transport", code: "unreachable", message: "fixture" }),
      ),
    ).toBe("host_unreachable");
    expect(
      yandexErrorCode(
        new HostError({ kind: "transport", code: "certificate_mismatch", message: "fixture" }),
      ),
    ).toBe("host_certificate_mismatch");
    expect(
      yandexErrorCode(
        new HostError({ kind: "api", status: 403, code: "forbidden", message: "fixture" }),
      ),
    ).toBe("office_forbidden");
  });

  it.each(YANDEX_ACTION_ERRORS)("has actionable copy for native reason %s", (code) => {
    expect(yandexErrorCode(code)).toBe(code);
    expect(i18n.exists(`yandex.errors.${code}`)).toBe(true);
  });

  it.each([
    ["quota", "quota_exceeded"],
    ["reauth", "reauth_required"],
    ["integrity", "integrity_failed"],
  ])("accepts the legacy native alias %s", (code, expected) => {
    expect(yandexErrorCode(code)).toBe(expected);
  });

  it("never exposes unknown native errors or arbitrary text", () => {
    expect(yandexErrorCode("private fixture value")).toBe("operation_failed");
    expect(yandexErrorCode(new Error("private fixture value"))).toBe("operation_failed");
  });
});
