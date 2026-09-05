import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { UsApp } from "../src/us/app.js";

const metadata = {
  edition: "US",
  releaseEnabled: false,
  interfaceLocales: ["en-US", "es-US"],
  defaultInterfaceLocale: "en-US",
};
const user = { id: "u1", email: "owner@example.test", name: "Owner", twoFactorEnabled: false };
const json = (body: unknown, status = 200) => Response.json(body, { status });
afterEach(cleanup);

function renderWith(responder: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const send = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => responder(String(input), init));
  const view = render(
    <ThemeProvider defaultTheme="light">
      <UsApp client={createUsBrowserClient(send)} />
    </ThemeProvider>,
  );
  return { send, ...view };
}

describe("US access and profile application", () => {
  it("attests deployment before showing login or making an auth call", async () => {
    const { send } = renderWith((path) =>
      path === "/api/us/deployment" ? json(metadata) : json(null),
    );
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      "/api/us/deployment",
      "/api/us-auth/get-session",
    ]);
  });

  it("blocks access when deployment attestation is invalid", async () => {
    const { send } = renderWith(() => json({ ...metadata, releaseEnabled: true }));
    expect(
      await screen.findByText("This interface could not verify the U.S. deployment."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps typed credentials while switching to Spanish", async () => {
    renderWith((path) => (path === "/api/us/deployment" ? json(metadata) : json(null)));
    const email = await screen.findByLabelText("Email");
    await userEvent.type(email, "owner@example.test");
    await userEvent.click(screen.getByText("Español"));
    expect((screen.getByLabelText("Correo electrónico") as HTMLInputElement).value).toBe(
      "owner@example.test",
    );
    expect(screen.getByRole("heading", { name: "Iniciar sesión" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("es-US");
  });

  it("clears enrollment secrets and returns to localized sign-in when verification expires", async () => {
    renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session")) return json(null);
      if (path.endsWith("sign-in/email")) return json({ token: "hidden", user });
      if (path.endsWith("two-factor/enable"))
        return json({
          totpURI: "otpauth://totp/Markiro:owner?secret=ABCDEF234567&issuer=Markiro",
          backupCodes: ["backup-one"],
        });
      if (path.endsWith("verify-totp")) return json({}, 401);
      return json({ success: true });
    });
    await userEvent.type(await screen.findByLabelText("Email"), user.email);
    await userEvent.type(screen.getByLabelText("Password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.type(await screen.findByLabelText("Confirm password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "I saved these backup codes" }),
    );
    await userEvent.type(screen.getByLabelText("6-digit authenticator code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("ABCDEF234567")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("session expired");
  });

  it("requires fresh sign-in when an enabled user has only a stale password session", async () => {
    renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session"))
        return json({
          user: { ...user, twoFactorEnabled: true },
          session: { activeOrganizationId: null },
        });
      if (path.endsWith("sign-out")) return json({ success: true });
      return json([], 403);
    });
    expect(
      await screen.findByText("Your password session is no longer MFA-verified. Sign in again."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("routes an existing password-only session directly to authenticator enrollment", async () => {
    const { send } = renderWith((path) =>
      path === "/api/us/deployment"
        ? json(metadata)
        : path.endsWith("get-session")
          ? json({ user, session: { activeOrganizationId: null } })
          : json([], 403),
    );
    expect(
      await screen.findByRole("heading", { name: "Set up multi-factor authentication" }),
    ).toBeTruthy();
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      "/api/us/deployment",
      "/api/us-auth/get-session",
    ]);
  });

  it("shows enrollment secret and backup codes, and requires saved-code acknowledgement", async () => {
    const { send } = renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session")) return json(null);
      if (path.endsWith("sign-in/email")) return json({ token: "hidden", user });
      if (path.endsWith("two-factor/enable"))
        return json({
          totpURI: "otpauth://totp/Markiro:owner?secret=ABCDEF234567&issuer=Markiro",
          backupCodes: ["backup-one"],
        });
      return json({ token: "hidden", user });
    });
    await userEvent.type(await screen.findByLabelText("Email"), user.email);
    await userEvent.type(screen.getByLabelText("Password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.type(await screen.findByLabelText("Confirm password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("ABCDEF234567")).toBeTruthy();
    expect(screen.getByText("backup-one")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify" })).toHaveProperty("disabled", true);
    expect(send.mock.calls.some(([path]) => path === "/api/us-auth/two-factor/enable")).toBe(true);
  });

  it("selects an organization before reading the profile and opens setup only for precise absence", async () => {
    let sessionReads = 0;
    const { send } = renderWith((path, init) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session")) {
        sessionReads++;
        return json({
          user: { ...user, twoFactorEnabled: true },
          session: { activeOrganizationId: sessionReads > 1 ? "org-1" : null },
        });
      }
      if (path.endsWith("organization/list"))
        return json([{ id: "org-1", name: "Synthetic Foods", slug: "synthetic" }]);
      if (path.endsWith("set-active"))
        return json({ id: "org-1", name: "Synthetic Foods", slug: "synthetic" });
      if (path.endsWith("profile") && init?.method === "GET")
        return json({ code: "traceability_profile_not_provisioned" }, 503);
      return json({ success: true });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Synthetic Foods" }));
    expect(
      await screen.findByRole("heading", { name: "Set up traceability profile" }),
    ).toBeTruthy();
    expect((screen.getByLabelText("Regulatory profile") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("Organization: Synthetic Foods")).toBeTruthy();
    expect(send.mock.calls.map(([path]) => path)).toContain("/api/us/traceability/profile");
  });

  it("enters connected reference data from the profile and always returns to the profile", async () => {
    const profile = {
      code: "US_FSMA204_PROCESSOR",
      timeZone: "America/Chicago",
      retentionYears: 5,
      baselineVersion: "US-REG-2026-09-03",
      effectiveAt: "2026-09-05T00:00:00.000Z",
    };
    const { send } = renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session"))
        return json({
          user: { ...user, twoFactorEnabled: true },
          session: { activeOrganizationId: "org-1" },
        });
      if (path.endsWith("organization/list"))
        return json([{ id: "org-1", name: "Synthetic Foods", slug: "synthetic" }]);
      if (path === "/api/us/traceability/profile") return json(profile);
      if (path === "/api/us/traceability/access")
        return json({ capabilities: ["traceability.read"] });
      if (path.startsWith("/api/us/traceability/parties?"))
        return json({ items: [], limit: 50, offset: 0 });
      return json({}, 404);
    });

    await userEvent.click(await screen.findByRole("button", { name: "Open reference data" }));
    expect(await screen.findByRole("heading", { name: "Parties" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Profile/ }));
    expect(await screen.findByRole("heading", { name: "Traceability profile" })).toBeTruthy();
    expect(send.mock.calls.map(([path]) => path)).toContain("/api/us/traceability/access");
  });

  it("clears enrollment password when signing out before another account", async () => {
    renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session"))
        return json({ user, session: { activeOrganizationId: null } });
      if (path.endsWith("sign-out")) return json({ success: true });
      if (path.endsWith("sign-in/email")) return json({ token: "hidden", user });
      return json({ success: true });
    });
    const confirm = await screen.findByLabelText("Confirm password");
    await userEvent.type(confirm, "first-account-secret");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await userEvent.type(await screen.findByLabelText("Email"), user.email);
    await userEvent.type(screen.getByLabelText("Password"), "second-account-secret");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(((await screen.findByLabelText("Confirm password")) as HTMLInputElement).value).toBe("");
  });

  it("ignores a login response that arrives after unmount", async () => {
    let resolveLogin!: (response: Response) => void;
    const loginResponse = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    const { send, unmount } = renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session")) return json(null);
      if (path.endsWith("sign-in/email")) return loginResponse;
      return json({ success: true });
    });
    await userEvent.type(await screen.findByLabelText("Email"), user.email);
    await userEvent.type(screen.getByLabelText("Password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    unmount();
    resolveLogin(json({ token: "hidden", user }));
    await loginResponse;
    await Promise.resolve();
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      "/api/us/deployment",
      "/api/us-auth/get-session",
      "/api/us-auth/sign-in/email",
    ]);
  });

  it("serializes logout after an in-flight MFA mutation and sends it only once", async () => {
    let resolveVerification!: (response: Response) => void;
    const verification = new Promise<Response>((resolve) => {
      resolveVerification = resolve;
    });
    const { send } = renderWith((path) => {
      if (path === "/api/us/deployment") return json(metadata);
      if (path.endsWith("get-session")) return json(null);
      if (path.endsWith("sign-in/email")) return json({ token: "hidden", user });
      if (path.endsWith("two-factor/enable"))
        return json({
          totpURI: "otpauth://totp/Markiro:owner?secret=ABCDEF234567&issuer=Markiro",
          backupCodes: ["backup-one"],
        });
      if (path.endsWith("verify-totp")) return verification;
      if (path.endsWith("sign-out")) return json({ success: true });
      return json([]);
    });
    await userEvent.type(await screen.findByLabelText("Email"), user.email);
    await userEvent.type(screen.getByLabelText("Password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.type(await screen.findByLabelText("Confirm password"), "synthetic-password");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "I saved these backup codes" }),
    );
    await userEvent.type(screen.getByLabelText("6-digit authenticator code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    const signOut = screen.getByRole("button", { name: "Sign out" });
    await userEvent.click(signOut);
    await userEvent.click(signOut);
    expect(send.mock.calls.filter(([path]) => String(path).endsWith("sign-out"))).toHaveLength(0);
    resolveVerification(json({ token: "hidden", user }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(send.mock.calls.filter(([path]) => String(path).endsWith("sign-out"))).toHaveLength(1);
    expect(send.mock.calls.filter(([path]) => String(path).endsWith("get-session"))).toHaveLength(
      1,
    );
  });
});
