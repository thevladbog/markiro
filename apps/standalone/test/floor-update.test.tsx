import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostMissingScreen } from "../src/app/screens.js";
import { FloorUpdateLine } from "../src/floor/FloorUpdateLine.js";
import { FloorUpdatePanel } from "../src/floor/FloorUpdatePanel.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";

const MANIFEST = {
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  notes: [],
  minUpgradeFrom: "0.2.0",
  protocol: 4,
  minProtocol: 4,
  sizeBytes: 200,
};
const BEHIND: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: MANIFEST,
};
const REQUIRED = { ...BEHIND, required: true } as const;

function inTheme(node: React.ReactNode) {
  return render(<ThemeProvider defaultTheme="dark">{node}</ThemeProvider>);
}

describe("the station's line (spec §10.11.5)", () => {
  it("says a new version waits for the administrator, only off a shift's work", () => {
    const { rerender } = inTheme(
      <FloorUpdateLine offer={BEHIND} appTooOld={false} inShift={false} />,
    );
    expect(screen.getByText("Есть новая версия программы; установит администратор.")).toBeTruthy();
    rerender(
      <ThemeProvider defaultTheme="dark">
        <FloorUpdateLine offer={BEHIND} appTooOld={false} inShift />
      </ThemeProvider>,
    );
    expect(screen.queryByText(/новая версия/)).toBeNull();
  });

  it("says this station is too old for the host, and holds nothing to press", () => {
    inTheme(<FloorUpdateLine offer={REQUIRED} appTooOld inShift={false} />);
    expect(screen.getByText(/слишком старая для хоста/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says there is no package when the host refuses this station and gives none", () => {
    inTheme(
      <FloorUpdateLine
        offer={{ kind: "unavailable", hostVersion: "0.3.0", reason: "missing" }}
        appTooOld
        inShift={false}
      />,
    );
    expect(screen.getByText(/пакета обновления на хосте нет/)).toBeTruthy();
  });

  it("says nothing on a shift's work even when the host refuses the station", () => {
    inTheme(<FloorUpdateLine offer={REQUIRED} appTooOld inShift />);
    expect(screen.queryByText(/слишком старая/)).toBeNull();
  });
});

describe("«Обновить с хоста» when the host refuses this PC (ЛО16)", () => {
  it("is a floor button on the sign-in screen", () => {
    const onUpdate = vi.fn();
    inTheme(<FloorUpdatePanel offer={REQUIRED} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: "Обновить с хоста" }));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("is on the version screen for an app the host finds too old, never for an old host", () => {
    const onUpdate = vi.fn();
    const { rerender } = inTheme(
      <HostMissingScreen
        reason="app_too_old"
        address="https://192.168.1.10:45710"
        onRetry={vi.fn()}
        onNetwork={null}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Обновить с хоста" }));
    expect(onUpdate).toHaveBeenCalled();
    rerender(
      <ThemeProvider defaultTheme="dark">
        <HostMissingScreen
          reason="host_too_old"
          address="x"
          onRetry={vi.fn()}
          onNetwork={null}
          onUpdate={onUpdate}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole("button", { name: "Обновить с хоста" })).toBeNull();
  });
});
