import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { GrantNotice, GrantDiagnostic } from "../src/ui/GrantNotice.js";
afterEach(cleanup);
it.each(["ru", "en"])(
  "shows recovery and clock guidance in %s without commercial details",
  async (language) => {
    await i18n.changeLanguage(language);
    const close = vi.fn();
    render(<GrantNotice reason="clock_untrusted" onClose={close} />);
    expect(screen.getByText(i18n.t("grantBlocked.clock"))).toBeDefined();
    expect(screen.getByText(i18n.t("grantBlocked.body"))).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("grantBlocked.close") }));
    expect(close).toHaveBeenCalledOnce();
  },
);
it("does not claim blocked work when there is no strict denial", () => {
  render(<GrantNotice reason={null} onClose={vi.fn()} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps observe diagnostics non-blocking and distinct from strict denial", async () => {
  await i18n.changeLanguage("en");
  render(
    <GrantDiagnostic
      status={{ mode: "observe", decision: { allow: false, reason: "missing_grant" } }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Current pickup work remains available");
  expect(screen.getByRole("status").style.padding).toBe("var(--sp-3) var(--sp-6)");
  expect(screen.getByRole("alert")).toBeDefined();
  expect(screen.queryByText("New pickup unavailable")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
