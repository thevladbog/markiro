import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Status } from "../src/pages/Status.js";
import type { AgentStatus } from "../src/lib/bridge.js";

vi.mock("../src/lib/bridge.js", () => ({
  bridge: {
    listCertificates: vi.fn().mockResolvedValue([]),
    selectCertificate: vi.fn(),
    unpair: vi.fn(),
    exportJournal: vi.fn().mockResolvedValue("C:\\Temp\\markiro-signer-logs.zip"),
  },
}));

const status: AgentStatus = {
  phase: "idle",
  appVersion: "0.1.5",
  hostname: "BUH-PC",
  tenantName: "ООО Ромашка",
  certThumbprint: null,
  lastTokenExpiresAt: null,
  lastError: null,
  journal: Array.from({ length: 21 }, (_, index) => ({
    occurredAt: `2026-09-01T10:${String(index).padStart(2, "0")}:00Z`,
    message: `Событие ${index + 1}`,
    detail: index === 20 ? "Подробности последнего события" : null,
  })),
};

describe("Status journal", () => {
  it("keeps diagnostics on a separate tab and paginates newest events", async () => {
    const user = userEvent.setup();
    render(
      <Status
        status={status}
        onChanged={vi.fn()}
        onCheckForUpdate={vi.fn().mockResolvedValue({ status: "current" })}
      />,
    );

    expect(screen.queryByText("Событие 21")).toBeNull();
    await user.click(screen.getByRole("tab", { name: /Журнал|Journal/ }));

    expect(screen.getByText("Событие 21")).toBeDefined();
    expect(screen.getByText("Подробности последнего события")).toBeDefined();
    expect(screen.queryByText("Событие 1")).toBeNull();
    expect(screen.getByText(/13:20|10:20/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: /Следующая|Next/ }));
    expect(screen.getByText("Событие 1")).toBeDefined();
    expect(screen.queryByText("Событие 21")).toBeNull();
  });

  it("exports the persistent journal and confirms where it was saved", async () => {
    const { bridge } = await import("../src/lib/bridge.js");
    const user = userEvent.setup();
    render(
      <Status
        status={status}
        onChanged={vi.fn()}
        onCheckForUpdate={vi.fn().mockResolvedValue({ status: "current" })}
      />,
    );

    await user.click(screen.getByRole("tab", { name: /Журнал|Journal/ }));
    await user.click(screen.getByRole("button", { name: /Экспортировать журнал|Export journal/ }));

    expect(bridge.exportJournal).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/markiro-signer-logs\.zip/)).toBeDefined();
  });
});
