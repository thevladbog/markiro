import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { StandaloneSitesPanel } from "../src/pages/tenants/StandaloneSitesPanel.js";
import { licensePhase } from "../src/pages/tenants/standalone-format.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { jsonResponse } from "./render.js";
import {
  STANDALONE_FILE,
  STANDALONE_ISSUANCE,
  STANDALONE_LICENSE_ID,
  STANDALONE_SITE,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
  STANDALONE_TENANT_ID,
} from "./standalone-fixtures.js";

vi.mock("../src/pages/tenants/standalone-download.js", () => ({ saveLicenseFile: vi.fn() }));

const BASE = `/api/platform/tenants/${STANDALONE_TENANT_ID}/standalone-sites`;

function stubApi(routes: Record<string, Array<() => Response>>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push(key);
      const queue = routes[key];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (!next) throw new Error(`Unexpected request: ${key}`);
      return next();
    }),
  );
  return calls;
}

function renderPanel() {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider defaultTheme="light">
          <MemoryRouter>
            <StandaloneSitesPanel tenantId={STANDALONE_TENANT_ID} />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(saveLicenseFile).mockReset();
  await i18n.changeLanguage("ru");
});

describe("standalone sites panel (plan ЛЦ-0)", () => {
  it("lists sites with the license phase in words, warns about renewal and downloads from the history", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`GET ${BASE}/${STANDALONE_SITE_ID}/issuances`]: [
        () => jsonResponse(200, { siteId: STANDALONE_SITE_ID, items: [STANDALONE_ISSUANCE] }),
      ],
      [`GET ${BASE}/${STANDALONE_SITE_ID}/issuances/${STANDALONE_LICENSE_ID}/file`]: [
        () => jsonResponse(200, STANDALONE_FILE),
      ],
    });
    renderPanel();

    expect(
      await screen.findByRole("heading", { level: 3, name: "Автоном: площадки и офлайн-лицензии" }),
    ).toBeDefined();
    const row = (await screen.findByText("Цех розлива")).closest("tr");
    if (!row) throw new Error("site row");
    expect(within(row).getByText("3f1c2d4e")).toBeDefined();
    expect(within(row).getByText("Пора продлить")).toBeDefined();
    expect(within(row).getByText(/№ 1 · до/u)).toBeDefined();
    expect(screen.getByText(/Лицензия площадки «Цех розлива» заканчивается/u)).toBeDefined();

    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "История выпусков: Цех розлива" }));
    const dialog = await screen.findByRole("dialog", { name: "История выпусков: Цех розлива" });
    await user.click(await within(dialog).findByRole("button", { name: "Скачать файл № 1" }));
    await vi.waitFor(() =>
      expect(vi.mocked(saveLicenseFile)).toHaveBeenCalledWith(
        "markiro-3f1c2d4e-001.mklic",
        STANDALONE_FILE.compact,
      ),
    );
    expect(calls).toEqual([
      `GET ${BASE}`,
      `GET ${BASE}/${STANDALONE_SITE_ID}/issuances`,
      `GET ${BASE}/${STANDALONE_SITE_ID}/issuances/${STANDALONE_LICENSE_ID}/file`,
    ]);
  });

  it("says when the tenant has no site and license signing is not configured", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        () =>
          jsonResponse(200, {
            tenantId: STANDALONE_TENANT_ID,
            signingConfigured: false,
            issuanceSource: "subscription",
            sites: [],
          }),
      ],
    });
    renderPanel();
    expect(
      await screen.findByText(
        "Подпись офлайн-лицензий на сервере не настроена: выпуск недоступен.",
      ),
    ).toBeDefined();
    expect(screen.getByText("У клиента нет площадок автонома.")).toBeDefined();
  });

  it("says the license is issued from the tenant's assignments, with no cloud access", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        () => jsonResponse(200, { ...STANDALONE_SITE_LIST, issuanceSource: "offline_assignments" }),
      ],
    });
    renderPanel();
    expect(
      await screen.findByText(
        "Клиент без кабинета: лицензия выпускается по его назначениям — тариф и дополнения с карточки клиента. Облачный доступ не открывается.",
      ),
    ).toBeDefined();
  });

  it("names the source of every journal row, also the removed manual offline terms and the assignments", async () => {
    const offlineRow = {
      ...STANDALONE_ISSUANCE,
      licenseId: "b2222222-2222-4222-8222-222222222222",
      sequence: 2,
      source: "offline",
      validUntilReason: "offline_term",
      entitlementRevision: "0",
    };
    const assignmentsRow = {
      ...STANDALONE_ISSUANCE,
      licenseId: "b3333333-3333-4333-8333-333333333333",
      sequence: 3,
      source: "offline_assignments",
      validUntilReason: "one_year_cap",
      sourceAssignments: [
        {
          kind: "plan",
          id: "d1111111-1111-4111-8111-111111111111",
          catalogVersionId: "c1111111-1111-4111-8111-111111111111",
        },
      ],
    };
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`GET ${BASE}/${STANDALONE_SITE_ID}/issuances`]: [
        () =>
          jsonResponse(200, {
            siteId: STANDALONE_SITE_ID,
            items: [assignmentsRow, offlineRow, STANDALONE_ISSUANCE],
          }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    const row = (await screen.findByText("Цех розлива")).closest("tr");
    if (!row) throw new Error("site row");
    await user.click(within(row).getByRole("button", { name: "История выпусков: Цех розлива" }));
    const dialog = await screen.findByRole("dialog", { name: "История выпусков: Цех розлива" });
    expect(await within(dialog).findByText("назначения клиента")).toBeDefined();
    expect(within(dialog).getByText("офлайн-условия")).toBeDefined();
    expect(within(dialog).getByText("подписка")).toBeDefined();
  });

  it("offers a retry when the sites cannot be loaded", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        () => jsonResponse(500, { code: "platform_internal_error" }),
        () => jsonResponse(200, STANDALONE_SITE_LIST),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Не удалось загрузить площадки автонома.")).toBeDefined();
    await userEvent.setup().click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Цех розлива")).toBeDefined();
  });
});

describe("licensePhase", () => {
  const now = new Date("2099-10-20T00:00:00.000Z");
  it("names a site without a file, a valid one, one due for renewal and an expired one", () => {
    expect(licensePhase({ latestIssuance: null, renewalDue: false }, now)).toBe("none");
    expect(licensePhase({ latestIssuance: STANDALONE_ISSUANCE, renewalDue: false }, now)).toBe(
      "active",
    );
    expect(licensePhase(STANDALONE_SITE, now)).toBe("attention");
    expect(licensePhase(STANDALONE_SITE, new Date("2099-11-01T09:00:00.000Z"))).toBe("retired");
  });
});
