import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CertificatePicker } from "../src/components/CertificatePicker.js";
import type { CertificateSummary } from "../src/lib/bridge.js";

// Radix's Select needs pointer-capture and scroll APIs jsdom does not
// implement; without these the trigger never opens in a test environment.
beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: () => undefined },
    releasePointerCapture: { value: () => undefined },
    scrollIntoView: { value: () => undefined },
  });
});

const usable: CertificateSummary = {
  thumbprint: "AB12",
  subject: "ООО Ромашка",
  inn: "7712345678",
  notAfter: "2030-01-01T00:00:00Z",
  hasPrivateKey: true,
};

const unusable: CertificateSummary = {
  thumbprint: "CD34",
  subject: "Без закрытого ключа",
  inn: null,
  notAfter: "2030-01-01T00:00:00Z",
  hasPrivateKey: false,
};

vi.mock("../src/lib/bridge.js", () => ({
  bridge: {
    listCertificates: vi.fn(),
    selectCertificate: vi.fn(),
  },
}));

describe("CertificatePicker", () => {
  // F3: the initial load filtered `hasPrivateKey`, but the refresh button's
  // handler assigned the raw list straight to state, so pressing refresh made
  // certificates with no private key reappear as selectable options. Both
  // paths must share one filter.
  it("keeps certificates without a private key out of the options, on load and after refresh", async () => {
    const { bridge } = await import("../src/lib/bridge.js");
    vi.mocked(bridge.listCertificates).mockResolvedValue([usable, unusable]);
    const user = userEvent.setup();

    render(<CertificatePicker selected={null} onSelected={vi.fn()} />);

    const trigger = await screen.findByRole("combobox");
    await user.click(trigger);
    expect(screen.getByRole("option", { name: /ООО Ромашка/ })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Без закрытого ключа/ })).toBeNull();
    await user.keyboard("{Escape}"); // close before the refresh re-renders the list

    await user.click(screen.getByRole("button", { name: /Обновить список|Refresh list/ }));

    await user.click(trigger);
    expect(screen.getByRole("option", { name: /ООО Ромашка/ })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Без закрытого ключа/ })).toBeNull();
  });
});
