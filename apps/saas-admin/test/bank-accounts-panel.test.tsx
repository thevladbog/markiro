import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";
import type { OperatorBankAccount } from "@markiro/platform-contracts";

import { BankAccountsPanel } from "../src/pages/legal/BankAccountsPanel";
import "../src/i18n/index";

const accounts: OperatorBankAccount[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    label: "Основной",
    settlementAccount: "40702810900000000001",
    bic: "044525225",
    bankName: "ПАО Сбербанк",
    correspondentAccount: "30101810400000000225",
    currency: "RUB",
    status: "active",
    isDefault: true,
    migrationSourceProfileId: null,
    createdByPlatformUserId: "user-1",
    archivedByPlatformUserId: null,
    archivedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  },
  {
    id: "21111111-1111-4111-8111-111111111111",
    label: "Резервный",
    settlementAccount: "40702810900000000002",
    bic: "044525225",
    bankName: "ПАО Сбербанк",
    correspondentAccount: "30101810400000000225",
    currency: "RUB",
    status: "active",
    isDefault: false,
    migrationSourceProfileId: null,
    createdByPlatformUserId: "user-1",
    archivedByPlatformUserId: null,
    archivedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  },
];

afterEach(() => cleanup());

describe("BankAccountsPanel", () => {
  it("masks account identifiers and confirms default/archive transitions", async () => {
    const setDefault = vi.fn(async () => undefined);
    const archive = vi.fn(async () => undefined);
    render(
      <ThemeProvider defaultTheme="light">
        <BankAccountsPanel
          accounts={accounts}
          canWrite
          busy={false}
          onCreate={vi.fn(async () => undefined)}
          onSetDefault={setDefault}
          onArchive={archive}
        />
      </ThemeProvider>,
    );
    const user = userEvent.setup();

    expect(screen.getByText("•••• 0001")).toBeDefined();
    expect(screen.getByText("•••• 0002")).toBeDefined();
    expect(screen.getAllByText("По умолчанию")).toHaveLength(1);

    const reserve = screen.getByRole("article", { name: "Резервный" });
    await user.click(within(reserve).getByRole("button", { name: "Сделать основным" }));
    expect(setDefault).toHaveBeenCalledWith(accounts[1]!.id);

    await user.click(within(reserve).getByRole("button", { name: "Архивировать" }));
    expect(archive).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Подтвердить архивирование",
      }),
    );
    expect(archive).toHaveBeenCalledWith(accounts[1]!.id, undefined);
  });
});
