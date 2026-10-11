import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { App } from "../src/App.js";
import type { AgentStatus, StorageNotice } from "../src/lib/bridge.js";
import { concernsPairing, storageNoticeKey } from "../src/lib/storage-notices.js";
import { Pairing } from "../src/pages/Pairing.js";
import { Status } from "../src/pages/Status.js";

vi.mock("../src/lib/bridge.js", () => ({
  bridge: {
    autostartEnabled: vi.fn().mockResolvedValue(true),
    setAutostartEnabled: vi.fn(),
    status: vi.fn(),
    onStatus: vi.fn(() => Promise.resolve(() => {})),
    listCertificates: vi.fn().mockResolvedValue([]),
    selectCertificate: vi.fn(),
    unpair: vi.fn(),
    pair: vi.fn(),
    exportJournal: vi.fn(),
  },
}));

const EVERY_NOTICE: StorageNotice[] = [
  { kind: "localLessDurable", reason: "temporaryProfile" },
  { kind: "localLessDurable", reason: "mandatoryProfile" },
  { kind: "localLessDurable", reason: "deleteRoamingCache" },
  { kind: "movePostponed" },
  { kind: "legacyCleanupPending" },
  { kind: "roamedCopyPresent", sameAgent: true },
  { kind: "roamedCopyPresent", sameAgent: false },
  { kind: "credentialUnreadable" },
];

function status(overrides: Partial<AgentStatus>): AgentStatus {
  return {
    phase: "idle",
    appVersion: "0.2.0",
    hostname: "BUH-PC",
    tenantName: "ООО Ромашка",
    certThumbprint: null,
    lastTokenExpiresAt: null,
    lastError: null,
    journal: [],
    storageNotices: [],
    ...overrides,
  };
}

describe("storage notices", () => {
  it("words every notice in both languages", () => {
    for (const notice of EVERY_NOTICE) {
      const key = storageNoticeKey(notice);
      expect(i18n.exists(key, { lng: "ru" }), `${key} (ru)`).toBe(true);
      expect(i18n.exists(key, { lng: "en" }), `${key} (en)`).toBe(true);
    }
  });

  it("shows every notice on the status tab", () => {
    const { container } = render(
      <Status
        status={status({ storageNotices: EVERY_NOTICE })}
        onChanged={vi.fn()}
        onCheckForUpdate={vi.fn().mockResolvedValue({ status: "current" })}
      />,
    );

    const notices = container.querySelector(".signer-storage-notices");
    expect(notices?.querySelectorAll('[role="alert"]').length).toBe(EVERY_NOTICE.length);
    expect(screen.getByText(/копия привязки этого агента/)).toBeDefined();
    expect(screen.getByText(/пока не удалось перенести/)).toBeDefined();
  });

  it("shows nothing extra when there is nothing to report", () => {
    const { container } = render(
      <Status
        status={status({})}
        onChanged={vi.fn()}
        onCheckForUpdate={vi.fn().mockResolvedValue({ status: "current" })}
      />,
    );

    expect(container.querySelector(".signer-storage-notices")).toBeNull();
  });

  it("repeats on the pairing screen only what concerns pairing", () => {
    render(
      <Pairing
        hostname="BUH-PC"
        onPair={vi.fn()}
        notices={[
          { kind: "credentialUnreadable" },
          { kind: "localLessDurable", reason: "temporaryProfile" },
          { kind: "movePostponed" },
        ]}
      />,
    );

    expect(screen.getByText(/не может прочитать этот пользователь Windows/)).toBeDefined();
    expect(screen.getByText(/временным профилем/)).toBeDefined();
    expect(screen.queryByText(/пока не удалось перенести/)).toBeNull();
    expect(EVERY_NOTICE.filter(concernsPairing)).toEqual([
      { kind: "localLessDurable", reason: "temporaryProfile" },
      { kind: "localLessDurable", reason: "mandatoryProfile" },
      { kind: "credentialUnreadable" },
    ]);
  });

  it("explains an unreadable credential on the pairing screen the app opens", async () => {
    const { bridge } = await import("../src/lib/bridge.js");
    vi.mocked(bridge.status).mockResolvedValue(
      status({
        phase: "unpaired",
        tenantName: null,
        storageNotices: [{ kind: "credentialUnreadable" }],
      }),
    );

    render(<App />);

    expect(await screen.findByText(/не может прочитать этот пользователь Windows/)).toBeDefined();
    expect(screen.getByLabelText(/код привязки/i)).toBeDefined();
  });
});
