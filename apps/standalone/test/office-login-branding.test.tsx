import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@markiro/ui";
import { describe, expect, it, vi } from "vitest";

import { OfficeLogin, type OfficeLoginProps } from "../src/office/OfficeLogin.js";
import type { OrgLogoState } from "../src/host/protocol.js";

const LOGO: OrgLogoState = {
  logo: { width: 8, height: 1, pixelsBase64: "gA==", updatedAt: "2026-10-30T00:00:00Z" },
};
function view(props: Partial<OfficeLoginProps> = {}, key = "site-a") {
  return (
    <ThemeProvider defaultTheme="light">
      <OfficeLogin
        key={key}
        notice={null}
        onLogin={async () => undefined}
        onBack={null}
        {...props}
      />
    </ThemeProvider>
  );
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("office login company branding", () => {
  it("shows the host-approved logo in both fixed slots without an office session", async () => {
    const readBranding = vi.fn().mockResolvedValue(LOGO);
    render(view({ readBranding }));
    await act(async () => undefined);
    expect(readBranding).toHaveBeenCalledOnce();
    const images = await screen.findAllByRole("img", { name: "Логотип организации" });
    expect(images).toHaveLength(2);
    expect(
      images.every((img) => img.getAttribute("src")?.startsWith("data:image/png;base64,")),
    ).toBe(true);
    expect(readBranding).toHaveBeenCalledWith();
    expect(screen.queryByText("маркиро")).toBeNull();
    expect(screen.getByRole("button", { name: "Войти" }).hasAttribute("disabled")).toBe(false);
  });

  it.each([
    ["no licensed logo", { logo: null }],
    ["invalid bitmap", { logo: { ...LOGO.logo, width: 8, height: 1, pixelsBase64: "not-base64" } }],
    ["blank bitmap", { logo: { ...LOGO.logo, width: 8, height: 1, pixelsBase64: "AA==" } }],
  ])("keeps Markiro for %s", async (_name, answer) => {
    const readBranding = vi.fn().mockResolvedValue(answer);
    render(view({ readBranding }));
    await waitFor(() => expect(readBranding).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(screen.queryByRole("img", { name: "Логотип организации" })).toBeNull();
    expect(screen.getByText("маркиро")).toBeTruthy();
  });

  it("leaves login usable while branding is pending or failed", async () => {
    const pending = deferred<OrgLogoState>();
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(view({ readBranding: () => pending.promise, onLogin }));
    fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "technolog" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ login: "technolog", password: "test-password" }),
    );
    const failed = vi.fn().mockRejectedValue(new Error("old host or offline"));
    rerender(view({ readBranding: failed }));
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(screen.getByText("маркиро")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back in both slots if the generated image cannot be displayed", async () => {
    render(view({ readBranding: async () => LOGO }));
    const images = await screen.findAllByRole("img", { name: "Логотип организации" });
    const first = images.at(0);
    if (first === undefined) throw new Error("logo missing");
    fireEvent.error(first);
    expect(screen.queryByRole("img", { name: "Логотип организации" })).toBeNull();
    expect(screen.getByText("маркиро")).toBeTruthy();
  });

  it("drops old-host answers and refreshes branding when the host revision changes", async () => {
    const old = deferred<OrgLogoState>();
    const readOld = () => old.promise;
    const readNew = vi.fn().mockResolvedValue({ logo: null });
    const { rerender } = render(view({ readBranding: readOld }));
    rerender(view({ readBranding: readNew }, "site-b"));
    await waitFor(() => expect(readNew).toHaveBeenCalledOnce());
    await act(async () => old.resolve(LOGO));
    expect(screen.queryByRole("img", { name: "Логотип организации" })).toBeNull();
    readNew.mockResolvedValue(LOGO);
    rerender(view({ readBranding: readNew, brandingRevision: 2 }, "site-b"));
    expect(await screen.findAllByRole("img", { name: "Логотип организации" })).toHaveLength(2);
    readNew.mockResolvedValue({ logo: null });
    rerender(view({ readBranding: readNew, brandingRevision: 3 }, "site-b"));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Логотип организации" })).toBeNull(),
    );
  });

  it("shows Markiro offline and asks for current branding on reconnection", async () => {
    const readBranding = vi.fn().mockResolvedValue(LOGO);
    const online = { state: "online", lastContactAt: null, lastError: null, seq: 1 } as const;
    const { rerender } = render(view({ readBranding, link: online }));
    await screen.findAllByRole("img", { name: "Логотип организации" });
    rerender(view({ readBranding, link: { ...online, state: "offline", seq: 2 } }));
    expect(screen.queryByRole("img", { name: "Логотип организации" })).toBeNull();
    expect(readBranding).toHaveBeenCalledTimes(1);
    rerender(view({ readBranding, link: { ...online, seq: 3 } }));
    await screen.findAllByRole("img", { name: "Логотип организации" });
    expect(readBranding).toHaveBeenCalledTimes(2);
  });
});
