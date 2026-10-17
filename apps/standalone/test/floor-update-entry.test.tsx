import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { SignInVersionFooter } from "../src/floor/sign-in/SignInVersionFooter.js";
import { StationPanel } from "../src/floor/setup/setup-parts.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import {
  FloorUpdateEntryProvider,
  InShiftUpdateEntry,
  type FloorUpdateEntry,
} from "../src/update/floor-update-entry-context.js";

const AVAILABLE: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: {
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    notes: ["Печать паллет быстрее", "Исправлена сверка"],
    minUpgradeFrom: "0.2.0",
    protocol: 6,
    minProtocol: 6,
    sizeBytes: 200,
  },
};

function entry(overrides: Partial<FloorUpdateEntry> = {}): FloorUpdateEntry {
  return {
    offer: { kind: "none" },
    appVersion: "0.2.1",
    check: vi.fn(),
    checking: false,
    checked: false,
    reachable: true,
    inShift: false,
    open: vi.fn(),
    ...overrides,
  };
}

function inTheme(value: FloorUpdateEntry | null, node: React.ReactNode) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <FloorUpdateEntryProvider value={value}>{node}</FloorUpdateEntryProvider>
    </ThemeProvider>,
  );
}

const facts = { name: "Станция 1", device: "dev-1", host: "10.0.0.5" };

describe("«Станция»: the version block", () => {
  it("shows the version and a check button", () => {
    const value = entry();
    inTheme(value, <StationPanel facts={facts} />);
    expect(screen.getByText(/Версия 0\.2\.1 · протокол \d+/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить обновление" }));
    expect(value.check).toHaveBeenCalledTimes(1);
  });

  it("says the last version is installed after a check that found nothing", () => {
    inTheme(entry({ checked: true }), <StationPanel facts={facts} />);
    expect(screen.getByText("Обновлений нет — установлена последняя версия.")).toBeTruthy();
  });

  it("says the update comes from the host PC when the host cannot be reached", () => {
    inTheme(entry({ reachable: false, checked: true }), <StationPanel facts={facts} />);
    expect(screen.getByText(/Обновление приходит с компьютера-хоста/)).toBeTruthy();
  });

  it("offers «Обновить» with the notes, and it opens the dialog", () => {
    const value = entry({ offer: AVAILABLE });
    inTheme(value, <StationPanel facts={facts} />);
    expect(screen.getByText("Доступна версия 0.3.0")).toBeTruthy();
    expect(screen.getByText("Печать паллет быстрее")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    expect(value.open).toHaveBeenCalledTimes(1);
  });

  it("holds the install back during a shift: the offer is told, no «Обновить»", () => {
    inTheme(
      entry({ offer: AVAILABLE }),
      <InShiftUpdateEntry>
        <StationPanel facts={facts} />
      </InShiftUpdateEntry>,
    );
    expect(screen.getByText("Доступна версия 0.3.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Обновить" })).toBeNull();
    expect(screen.getByText(/вне смены/)).toBeTruthy();
    // The read-only check stays.
    expect(screen.getByRole("button", { name: "Проверить обновление" })).toBeTruthy();
  });

  it("draws nothing without an entry (outside the app)", () => {
    inTheme(null, <StationPanel facts={facts} />);
    expect(screen.queryByText("Проверить обновление")).toBeNull();
  });
});

describe("the sign-in's footer", () => {
  it("shows the version as quiet text, no button, when there is no offer", () => {
    inTheme(entry(), <SignInVersionFooter />);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText(/Версия 0\.2\.1/)).toBeTruthy();
    expect(within(footer).queryByRole("button")).toBeNull();
  });

  it("adds «Доступно обновление» when the host offers one, and it opens the dialog", () => {
    const value = entry({ offer: AVAILABLE });
    inTheme(value, <SignInVersionFooter />);
    fireEvent.click(screen.getByRole("button", { name: "Доступно обновление" }));
    expect(value.open).toHaveBeenCalledTimes(1);
  });

  it("offers nothing while the host is unreachable", () => {
    inTheme(entry({ offer: AVAILABLE, reachable: false }), <SignInVersionFooter />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the entry exists in both places of the floor", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("is wired into the «Станция» tab and the sign-in screen", () => {
    expect(source("src/floor/setup/setup-parts.tsx")).toContain("<StationUpdateBlock />");
    expect(source("src/floor/OperatorSignIn.tsx")).toContain("<SignInVersionFooter />");
  });

  it("holds the install back when the setup was opened from a shift", () => {
    const app = source("src/floor/FloorApp.tsx");
    expect(app).toContain("<InShiftUpdateEntry>{setupScreen}</InShiftUpdateEntry>");
    expect(app).toContain('back !== null && back !== "warehouse"');
  });

  it("is provided by the app from the one check, with a way to open the dialog", () => {
    const app = source("src/app/App.tsx");
    expect(app).toContain("<FloorFrameWithUpdateEntry");
    expect(app).toContain("open: () => setUpdateOpen(true)");
  });
});
