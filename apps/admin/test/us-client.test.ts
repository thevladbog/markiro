import { describe, expect, it, vi } from "vitest";
import * as client from "../src/us/client.js";

const user = { id: "user-1", email: "owner@example.test", name: "Owner", twoFactorEnabled: false };
const profile = {
  code: "US_FSMA204_PROCESSOR",
  timeZone: "America/Chicago",
  retentionYears: 5,
  baselineVersion: "US-REG-2026-09-03",
  effectiveAt: "2026-09-05T00:00:00.000Z",
};

function transport(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
}

describe("US browser client boundary", () => {
  it("attests the exact locked US deployment metadata", async () => {
    const send = transport({
      edition: "US",
      releaseEnabled: false,
      interfaceLocales: ["en-US", "es-US"],
      defaultInterfaceLocale: "en-US",
    });
    await expect(client.createUsBrowserClient(send).deployment()).resolves.toEqual({
      edition: "US",
      releaseEnabled: false,
      interfaceLocales: ["en-US", "es-US"],
      defaultInterfaceLocale: "en-US",
    });
    expect(send.mock.calls[0]?.[0]).toBe("/api/us/deployment");
  });

  it("rejects release-enabled or cross-edition deployment metadata", async () => {
    for (const body of [
      {
        edition: "RU",
        releaseEnabled: false,
        interfaceLocales: ["en-US", "es-US"],
        defaultInterfaceLocale: "en-US",
      },
      {
        edition: "US",
        releaseEnabled: true,
        interfaceLocales: ["en-US", "es-US"],
        defaultInterfaceLocale: "en-US",
      },
    ]) {
      await expect(
        client.createUsBrowserClient(transport(body)).deployment(),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("sends password login only to the US auth path, without redirect following or retries", async () => {
    const send = transport({ token: "must-not-escape", user });
    const api = client.createUsBrowserClient(send);
    expect(await api.signIn({ email: user.email, password: "synthetic-password" })).toEqual({
      step: "password_session",
    });
    expect(send).toHaveBeenCalledExactlyOnceWith("/api/us-auth/sign-in/email", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "synthetic-password" }),
    });
  });

  it("bounds a hung request and maps the abort to unavailable", async () => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const request = client.createUsBrowserClient(send).session();
    const assertion = expect(request).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    vi.useRealTimers();
  });

  it("keeps the timeout active while the response body is stalled", async () => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const request = client.createUsBrowserClient(send).session();
    const assertion = expect(request).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    vi.useRealTimers();
  });

  it("does not turn a login challenge into an authenticated session", async () => {
    const api = client.createUsBrowserClient(transport({ twoFactorRedirect: true }));
    expect(await api.signIn({ email: user.email, password: "synthetic-password" })).toEqual({
      step: "mfa_required",
    });
  });

  it("returns only the UI session fields and never exposes bearer tokens", async () => {
    const api = client.createUsBrowserClient(
      transport({
        user,
        session: { id: "session-1", token: "secret", activeOrganizationId: "org-1" },
      }),
    );
    expect(await api.session()).toEqual({ user, activeOrganizationId: "org-1" });
    expect(await client.createUsBrowserClient(transport(null)).session()).toBeNull();
  });

  it("keeps enrollment material only in the explicit result, validates the authenticator URI", async () => {
    const enrollment = {
      totpURI: "otpauth://totp/Markiro:owner?secret=ABCDEF234567&issuer=Markiro%20US",
      backupCodes: ["synthetic-backup"],
    };
    const send = transport(enrollment);
    expect(
      await client.createUsBrowserClient(send).enroll({ password: "synthetic-password" }),
    ).toEqual(enrollment);
    expect(send.mock.calls[0]?.[0]).toBe("/api/us-auth/two-factor/enable");
  });

  it.each([
    "https://remote.example/secret",
    "javascript:alert(1)",
    "otpauth://hotp/test?secret=ABC",
  ])("refuses an unexpected enrollment URI %s", async (totpURI) => {
    const api = client.createUsBrowserClient(
      transport({ totpURI, backupCodes: ["synthetic-backup"] }),
    );
    await expect(api.enroll({ password: "synthetic-password" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("verifies TOTP and backup codes without adding trusted-device or sessionless flags", async () => {
    const send = transport({ token: "must-not-escape", user });
    const api = client.createUsBrowserClient(send);
    expect(await api.verifyTotp({ code: "123456" })).toBeUndefined();
    expect(await api.verifyBackupCode({ code: "synthetic-backup" })).toBeUndefined();
    expect(send.mock.calls.map(([path, init]) => [path, init?.body])).toEqual([
      ["/api/us-auth/two-factor/verify-totp", '{"code":"123456"}'],
      ["/api/us-auth/two-factor/verify-backup-code", '{"code":"synthetic-backup"}'],
    ]);
  });

  it("leaves organization selection server-owned and reads only the selected profile", async () => {
    const send = transport(profile);
    const api = client.createUsBrowserClient(send);
    expect(await api.profile()).toEqual(profile);
    expect(send.mock.calls[0]?.[0]).toBe("/api/us/traceability/profile");
    expect(
      await api.provisionProfile({ code: "US_FSMA204_PROCESSOR", timeZone: "America/Chicago" }),
    ).toEqual(profile);
    expect(send.mock.calls[1]?.[1]?.body).toBe(
      '{"code":"US_FSMA204_PROCESSOR","timeZone":"America/Chicago","retentionYears":5}',
    );
  });

  it("lists organizations without exposing metadata and selects only the supplied ID", async () => {
    const send = transport([
      { id: "org-1", name: "Synthetic", slug: "synthetic", metadata: "private" },
    ]);
    const api = client.createUsBrowserClient(send);
    expect(await api.organizations()).toEqual([
      { id: "org-1", name: "Synthetic", slug: "synthetic" },
    ]);
    send.mockResolvedValueOnce(
      Response.json({ id: "org-1", name: "Synthetic", slug: "synthetic" }),
    );
    await api.selectOrganization({ organizationId: "org-1" });
    expect(send.mock.calls[1]?.[0]).toBe("/api/us-auth/organization/set-active");
    expect(send.mock.calls[1]?.[1]?.body).toBe('{"organizationId":"org-1"}');
  });

  it("signs out only through US auth", async () => {
    const send = transport({ success: true });
    await client.createUsBrowserClient(send).signOut();
    expect(send.mock.calls[0]?.[0]).toBe("/api/us-auth/sign-out");
  });

  it.each([
    [401, { message: "secret driver output" }, "session_required"],
    [403, { message: "secret driver output" }, "forbidden"],
    [409, { message: "secret driver output" }, "conflict"],
    [429, { message: "secret driver output" }, "rate_limited"],
    [503, { code: "traceability_profile_not_provisioned" }, "profile_not_provisioned"],
    [503, { message: "secret driver output" }, "unavailable"],
  ] as const)("maps HTTP %s to safe machine-readable UI errors", async (status, body, code) => {
    const send = transport(body, status);
    await expect(client.createUsBrowserClient(send).profile()).rejects.toMatchObject({
      code,
      message: code,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a missing-profile error on an auth route for onboarding", async () => {
    const api = client.createUsBrowserClient(
      transport({ code: "traceability_profile_not_provisioned" }, 503),
    );
    await expect(api.session()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("sanitizes transport and malformed response failures", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("credential-bearing driver detail"));
    await expect(client.createUsBrowserClient(send).session()).rejects.toMatchObject({
      code: "unavailable",
      message: "unavailable",
    });
    await expect(client.createUsBrowserClient(transport({ user })).session()).rejects.toMatchObject(
      { code: "invalid_response" },
    );
    await expect(
      client
        .createUsBrowserClient(transport({}))
        .signIn({ email: user.email, password: "synthetic-password" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects malformed or cross-edition profile data rather than defaulting it", async () => {
    for (const body of [
      { ...profile, code: "RU_CHZ" },
      { ...profile, retentionYears: undefined },
      { ...profile, timeZone: "Mars/Olympus" },
    ]) {
      await expect(client.createUsBrowserClient(transport(body)).profile()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("rejects widened mutation input before any network call", async () => {
    const send = transport({});
    const api = client.createUsBrowserClient(send);
    await expect(
      api.provisionProfile({
        code: "US_FSMA204_PROCESSOR",
        timeZone: "America/Chicago",
        tenantId: "other",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(api.verifyTotp({ code: "123456", trustDevice: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(api.signIn({ email: "invalid", password: "secret" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
