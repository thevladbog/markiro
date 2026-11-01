import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostStatusDot } from "../src/app/HostStatusDot.js";
import type { SyncState } from "../src/app/shell.js";
import type { HostStatus } from "../src/host/protocol.js";

const ONLINE: HostStatus = { state: "online", lastContactAt: 1000, lastError: null, seq: 1 };
const HEALTHY: SyncState = { kind: "done", synced: 12, failure: null, quarantined: 0 };

describe("compact healthy host status", () => {
  it("keeps the existing word chip by default for other consumers", () => {
    render(<HostStatusDot status={ONLINE} sync={HEALTHY} />);
    const button = screen.getByRole("button", { name: "Связь с хостом: На связи с хостом" });
    expect(within(button).getByText("Хост на связи")).toBeTruthy();
    expect(button.querySelector(".status-dot")).toBeNull();
  });

  it("shows only a green dot with an accessible button and tooltip, retaining its details and Escape behavior", () => {
    render(<HostStatusDot status={ONLINE} sync={HEALTHY} compactWhenHealthy />);
    const label = "Связь с хостом: На связи с хостом";
    const button = screen.getByRole("button", { name: label });
    expect(button.querySelector(".status-dot--ok")).not.toBeNull();
    expect(button.querySelector(".office-chip")).toBeNull();
    expect(button.textContent).toBe("");
    expect(button.title).toBe(label);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(
      within(screen.getByRole("region", { name: label })).getByText("На связи с хостом"),
    ).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it.each([
    { status: null, sync: null, text: "Связь не проверена" },
    { status: { ...ONLINE, state: "connecting" }, sync: null, text: "Подключение" },
    { status: { ...ONLINE, state: "offline" }, sync: null, text: "Нет связи" },
    { status: ONLINE, sync: { ...HEALTHY, failure: "host" }, text: "Есть замечания" },
    { status: ONLINE, sync: { ...HEALTHY, quarantined: 2 }, text: "Есть замечания" },
  ] satisfies { status: HostStatus | null; sync: SyncState | null; text: string }[])(
    "keeps the nonhealthy word chip: $text",
    ({ status, sync, text }) => {
      render(<HostStatusDot status={status} sync={sync} compactWhenHealthy />);
      const button = screen.getByRole("button");
      expect(within(button).getByText(text)).toBeTruthy();
      expect(button.querySelector(".status-dot")).toBeNull();
      expect(button.querySelector(".office-chip")).not.toBeNull();
    },
  );

  it("restores the word chip when an initially healthy connection fails", () => {
    const view = render(<HostStatusDot status={ONLINE} sync={HEALTHY} compactWhenHealthy />);
    view.rerender(
      <HostStatusDot status={{ ...ONLINE, state: "offline" }} sync={HEALTHY} compactWhenHealthy />,
    );
    expect(screen.getByRole("button").querySelector(".status-dot")).toBeNull();
    expect(within(screen.getByRole("button")).getByText("Нет связи")).toBeTruthy();
  });
});
