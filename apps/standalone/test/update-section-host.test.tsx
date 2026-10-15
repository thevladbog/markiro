import { readFileSync } from "node:fs";

import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { officeUpdateStatusSchema } from "../src/host/distribution.js";
import type { AboutApi } from "../src/office/info/about-api.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import { DeviceVersionsBlock } from "../src/office/info/DeviceVersionsBlock.js";
import { HostUpdateBlock } from "../src/office/info/HostUpdateBlock.js";
import { StageToHostButton } from "../src/office/info/StageToHostButton.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import type { HostUpdateOffer } from "../src/update/host-offer.js";
import { UpdateOfferProvider } from "../src/update/offer-context.js";
import { UpdateError, type UpdatesApi } from "../src/update/updates-api.js";
import { UpdatesProvider } from "../src/update/updates-context.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const testModuleUrl = import.meta.url;
const STATUS = officeUpdateStatusSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-update-status.json", testModuleUrl), "utf8"),
  ) as unknown,
);

const AVAILABLE: HostUpdateOffer = {
  kind: "available",
  hostVersion: "0.3.0",
  required: false,
  manifest: {
    version: "0.3.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    notes: ["Раздача обновления через хост"],
    minUpgradeFrom: "0.2.0",
    protocol: 4,
    minProtocol: 3,
    sizeBytes: 200,
  },
};

function about(role: "host" | "station" | "office"): AboutApi {
  return {
    appVersion: async () => "0.2.1",
    installRole: async () => role,
    pairing: async () => DEVICE_STATUS,
    hello: async () => observation(true),
    system: async () => ({ os: "Windows 11", arch: "x64", webview: null }),
    openLink: async () => undefined,
  };
}

function fakeUpdates(overrides: Partial<UpdatesApi> = {}): UpdatesApi {
  return {
    appVersion: vi.fn(async () => "0.2.1"),
    checkManifest: vi.fn(async () => {
      throw new UpdateError("refused", "x");
    }),
    fetch: vi.fn(async () => ({ version: "0.3.0", manifestPath: "m", sizeBytes: 200 })),
    stage: vi.fn(async () => ({ version: "0.4.0", sizeBytes: 200 })),
    ...overrides,
  };
}

function sessionOf(user?: typeof TECHNOLOGIST): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getUpdateStatus.mockResolvedValue(STATUS);
  return session;
}

function renderWith(
  node: ReactNode,
  {
    session = sessionOf(),
    role = "station",
    offer = AVAILABLE,
    updates = fakeUpdates(),
  }: {
    session?: FakeOfficeSession;
    role?: "host" | "station" | "office";
    offer?: HostUpdateOffer;
    updates?: UpdatesApi;
  } = {},
) {
  render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <AboutProvider value={about(role)}>
            <UpdatesProvider value={updates}>
              <UpdateOfferProvider value={offer}>{node}</UpdateOfferProvider>
            </UpdatesProvider>
          </AboutProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { session, updates };
}

describe("«Устройства и версии»", () => {
  it("shows the summary, the host's package and every device's state in words", async () => {
    renderWith(<DeviceVersionsBlock />, { session: sessionOf(TECHNOLOGIST) });
    expect(
      await screen.findByText(
        "Хост: 0.3.0. Актуальны: 1 из 5; отстают: 1; несовместимы: 1; новее хоста: 1; версия неизвестна: 1",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Пакет обновления 0\.3\.0 на хосте проверен/)).toBeTruthy();
    for (const state of [
      "Актуальная",
      "Отстаёт, совместима",
      "Несовместима — не подключится",
      "Новее хоста",
      "Неизвестно",
    ]) {
      expect(screen.getByText(state)).toBeTruthy();
    }
    expect(screen.getByText(/Запущена установка/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "История обновлений", level: 4 })).toBeTruthy();
  });
});

describe("the update history", () => {
  it("lists equal entries without a duplicate key and words an unknown action generically", async () => {
    const entry = STATUS.history[0];
    if (entry === undefined) throw new Error("no history in the fixture");
    const session = sessionOf(TECHNOLOGIST);
    session.api.getUpdateStatus.mockResolvedValue({
      ...STATUS,
      history: [entry, entry, { ...entry, action: "update.from.the.future" }],
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderWith(<DeviceVersionsBlock />, { session });
    await screen.findByRole("heading", { name: "История обновлений", level: 4 });
    expect(screen.getAllByText(/другое событие обновления/)).toHaveLength(1);
    expect(screen.queryByText(/update\.from\.the\.future/)).toBeNull();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });
});

describe("«С хоста»", () => {
  it("offers the administrator the update and opens «Обновить с хоста»", async () => {
    renderWith(<HostUpdateBlock />);
    expect(
      await screen.findByText(
        "Хост работает на версии 0.3.0, этот ПК — 0.2.1. Доступно обновление.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить с хоста" }));
    expect(screen.getByRole("dialog", { name: "Обновление 0.3.0 с хоста" })).toBeTruthy();
  });

  it("tells the technologist that an administrator installs it", async () => {
    renderWith(<HostUpdateBlock />, { session: sessionOf(TECHNOLOGIST) });
    expect(await screen.findByText("Доступно обновление; установит администратор.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Обновить с хоста" })).toBeNull();
  });

  it("is not on the host's PC, which updates from a file", async () => {
    renderWith(<HostUpdateBlock />, { role: "host" });
    // The role is read once; after it the block stays empty.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("heading", { name: "С хоста" })).toBeNull();
  });

  it("explains a host that gives no package and one older than this PC", async () => {
    renderWith(<HostUpdateBlock />, {
      offer: { kind: "unavailable", hostVersion: "0.3.0", reason: "missing" },
    });
    expect(await screen.findByText(/на нём нет пакета обновления этой версии/)).toBeTruthy();
  });
});

describe("«Загрузить пакет на хост»", () => {
  it("stages a found package with the session and says so", async () => {
    const { updates } = renderWith(
      <StageToHostButton manifestPath={"E:\\Markiro\\m.update.jws"} />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Загрузить пакет на хост" }));
    });
    expect(updates.stage).toHaveBeenCalledWith("E:\\Markiro\\m.update.jws", SESSION.token);
    expect(screen.getByText("Пакет 0.4.0 загружен на хост и ждёт обновления хоста.")).toBeTruthy();
  });

  it("explains a refusal", async () => {
    renderWith(<StageToHostButton manifestPath="m" />, {
      updates: fakeUpdates({
        stage: vi.fn(async () => Promise.reject(new UpdateError("package_not_newer", "x"))),
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Загрузить пакет на хост" }));
    });
    expect(screen.getByText("Пакет не новее версии хоста: загружать его не нужно.")).toBeTruthy();
  });

  it("is hidden from a technologist", () => {
    renderWith(<StageToHostButton manifestPath="m" />, { session: sessionOf(TECHNOLOGIST) });
    expect(screen.queryByRole("button", { name: "Загрузить пакет на хост" })).toBeNull();
  });
});
