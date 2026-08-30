import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CertificatePicker } from "../src/components/CertificatePicker.js";
import type { CertificateSummary } from "../src/lib/bridge.js";

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

    expect(await screen.findByRole("radio", { name: /ООО Ромашка/ })).toBeDefined();
    expect(screen.queryByRole("radio", { name: /Без закрытого ключа/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Обновить список|Refresh list/ }));

    expect(screen.getByRole("radio", { name: /ООО Ромашка/ })).toBeDefined();
    expect(screen.queryByRole("radio", { name: /Без закрытого ключа/ })).toBeNull();
  });

  it("shows the certificate owner, INN, expiration date, and thumbprint without truncation", async () => {
    const { bridge } = await import("../src/lib/bridge.js");
    vi.mocked(bridge.listCertificates).mockResolvedValue([usable]);

    render(<CertificatePicker selected="AB12" onSelected={vi.fn()} />);

    expect(
      ((await screen.findByRole("radio", { name: /ООО Ромашка/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText(/ИНН: 7712345678|INN: 7712345678/)).toBeDefined();
    expect(screen.getByText(/Действует до.*2030|Valid until.*2030/)).toBeDefined();
    expect(screen.getByText(/Отпечаток: AB12|Thumbprint: AB12/)).toBeDefined();
  });
});
