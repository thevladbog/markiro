import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { standaloneSiteInspectRequestSchema } from "@markiro/platform-contracts";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { StandaloneSitesPanel } from "../src/pages/tenants/StandaloneSitesPanel.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { ADDON, jsonResponse, PUBLISHED_PLAN } from "./render.js";
import {
  STANDALONE_FILE,
  STANDALONE_INSPECTION,
  STANDALONE_PREVIEW,
  STANDALONE_SITE,
  STANDALONE_SITE_ID,
  STANDALONE_SITE_LIST,
  STANDALONE_TENANT_ID,
} from "./standalone-fixtures.js";

vi.mock("../src/pages/tenants/standalone-download.js", () => ({ saveLicenseFile: vi.fn() }));

const BASE = `/api/platform/tenants/${STANDALONE_TENANT_ID}/standalone-sites`;
const REQUEST_ID = "f1111111-1111-4111-8111-111111111111";
// Vitest runs from apps/saas-admin; jsdom's import.meta.url is not a file URL.
const activationText = readFileSync(
  "../../packages/domain/fixtures/standalone-license/activation-request.json",
  "utf8",
);
const activationRequest = standaloneSiteInspectRequestSchema.shape.request.parse(
  JSON.parse(activationText),
);

type Call = { key: string; body: unknown };

function stubApi(routes: Record<string, Array<() => Response>>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${String(input)}`;
      calls.push({ key, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
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
          <StandaloneSitesPanel tenantId={STANDALONE_TENANT_ID} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function activationFile(content = activationText): File {
  return new File([content], "activation-request.json", { type: "application/json" });
}

async function siteRow(): Promise<HTMLElement> {
  const row = (await screen.findByText("Цех розлива")).closest("tr");
  if (!row) throw new Error("site row");
  return row;
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(saveLicenseFile).mockReset();
  await i18n.changeLanguage("ru");
});

describe("standalone site registration (plan ЛЦ-0)", () => {
  it("registers a site after the operator acknowledges the INN mismatch", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`POST ${BASE}/inspect`]: [() => jsonResponse(200, STANDALONE_INSPECTION)],
      [`POST ${BASE}`]: [
        () =>
          jsonResponse(200, {
            ...STANDALONE_SITE,
            id: "a2222222-2222-4222-8222-222222222222",
            hostId: STANDALONE_INSPECTION.hostId,
            name: "Склад",
            latestIssuance: null,
            renewalDue: false,
            lastIssuedSequence: 0,
          }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
    await user.upload(within(dialog).getByTestId("file-drop-input"), activationFile());

    expect(
      await within(dialog).findByText(
        "ИНН запроса не совпадает с ИНН в профиле организации клиента.",
      ),
    ).toBeDefined();
    const submit = within(dialog).getByRole("button", { name: "Добавить площадку" });
    await user.type(within(dialog).getByLabelText("Название площадки"), "Склад");
    expect(submit).toHaveProperty("disabled", true);
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Расхождения проверены, площадку можно привязать",
      }),
    );
    expect(submit).toHaveProperty("disabled", false);
    await user.click(submit);

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: `POST ${BASE}/inspect`, body: { request: activationRequest } },
      {
        key: `POST ${BASE}`,
        body: {
          intent: "create",
          requestId: REQUEST_ID,
          name: "Склад",
          request: activationRequest,
          acknowledgedWarnings: ["request_inn_differs_org"],
        },
      },
    ]);
    expect(calls.filter((call) => call.key === `GET ${BASE}`)).toHaveLength(2);
  });

  it("refuses an unreadable file locally and a host bound elsewhere without a way to submit", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`POST ${BASE}/inspect`]: [
        () => jsonResponse(200, { ...STANDALONE_INSPECTION, warnings: [], blocking: "host_taken" }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
    const input = within(dialog).getByTestId("file-drop-input");

    await user.upload(input, activationFile("{not json"));
    expect(await within(dialog).findByText("Файл не читается как JSON.")).toBeDefined();
    expect(calls.some((call) => call.key === `POST ${BASE}/inspect`)).toBe(false);

    await user.upload(input, activationFile());
    expect(
      await within(dialog).findByText("Этот хост уже привязан к площадке другого клиента."),
    ).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Добавить площадку" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).queryByLabelText("Название площадки")).toBeNull();
  });

  it("binds a new host id to an existing site", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [`POST ${BASE}/inspect`]: [
        () => jsonResponse(200, { ...STANDALONE_INSPECTION, warnings: [] }),
      ],
      [`POST ${BASE}`]: [
        () => jsonResponse(200, { ...STANDALONE_SITE, hostId: STANDALONE_INSPECTION.hostId }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
    await user.upload(within(dialog).getByTestId("file-drop-input"), activationFile());
    await user.click(
      await within(dialog).findByRole("radio", { name: "Новый хост площадки «Цех розлива»" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Привязать новый хост" }));

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((call) => call.key === `POST ${BASE}`)?.body).toEqual({
      intent: "rebind",
      requestId: REQUEST_ID,
      siteId: STANDALONE_SITE_ID,
      request: activationRequest,
      acknowledgedWarnings: [],
    });
  });
});

describe("offline license issuance (plan ЛЦ-0)", () => {
  const PREVIEW = `POST ${BASE}/${STANDALONE_SITE_ID}/issuances/preview`;
  const CONFIRM = `POST ${BASE}/${STANDALONE_SITE_ID}/issuances`;

  it("previews «before → after» with highlights, confirms with the preview's expectation and downloads", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const issued = {
      ...STANDALONE_FILE,
      issuance: { ...STANDALONE_FILE.issuance, sequence: 2 },
      fileName: "markiro-3f1c2d4e-002.mklic",
    };
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [PREVIEW]: [() => jsonResponse(200, STANDALONE_PREVIEW)],
      [CONFIRM]: [() => jsonResponse(200, issued)],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      within(await siteRow()).getByRole("button", {
        name: "Выпустить офлайн-лицензию: Цех розлива",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Выпуск офлайн-лицензии: Цех розлива",
    });
    expect(within(dialog).getByRole("button", { name: "Подтвердить и скачать" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));

    const table = await within(dialog).findByRole("table", { name: "Было → станет" });
    const stations = within(table).getByRole("row", { name: /Станции и ТСД/u });
    expect(
      within(stations)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["3", "5"]);
    expect(
      within(within(table).getByRole("row", { name: /Линии/u })).getByText("меньше использования"),
    ).toBeDefined();
    expect(
      within(within(table).getByRole("row", { name: /Честный знак/u })).getByText(
        "нет сопоставления",
      ),
    ).toBeDefined();
    expect(
      within(dialog).getByText("Линии: в лицензии 2, а на площадке уже 3 — новые не подключатся."),
    ).toBeDefined();

    await user.click(within(dialog).getByRole("button", { name: "Подтвердить и скачать" }));
    expect(await within(dialog).findByText("Файл № 2 выпущен и скачан.")).toBeDefined();
    expect(vi.mocked(saveLicenseFile)).toHaveBeenCalledWith(
      "markiro-3f1c2d4e-002.mklic",
      STANDALONE_FILE.compact,
    );
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: PREVIEW, body: { graceDays: null, offline: null } },
      {
        key: CONFIRM,
        body: {
          requestId: REQUEST_ID,
          graceDays: null,
          offline: null,
          expected: STANDALONE_PREVIEW.expected,
        },
      },
    ]);
  });

  it("sends the typed grace period, refuses an invalid one locally and asks for a new preview when stale", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [PREVIEW]: [() => jsonResponse(200, STANDALONE_PREVIEW)],
      [CONFIRM]: [() => jsonResponse(409, { code: "standalone_license_preview_stale" })],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      within(await siteRow()).getByRole("button", {
        name: "Выпустить офлайн-лицензию: Цех розлива",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Выпуск офлайн-лицензии: Цех розлива",
    });
    const grace = within(dialog).getByLabelText("Льготный срок, дней");

    await user.type(grace, "61");
    expect(within(dialog).getByText("Целое число от 0 до 60.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Предпросмотр" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.clear(grace);
    await user.type(grace, "7");
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    await within(dialog).findByRole("table", { name: "Было → станет" });
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить и скачать" }));

    expect(
      await within(dialog).findByText(
        "Права или выпуски площадки изменились — посмотрите предпросмотр заново.",
      ),
    ).toBeDefined();
    expect(within(dialog).queryByRole("table", { name: "Было → станет" })).toBeNull();
    expect(vi.mocked(saveLicenseFile)).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: PREVIEW, body: { graceDays: 7, offline: null } },
      {
        key: CONFIRM,
        body: {
          requestId: REQUEST_ID,
          graceDays: 7,
          offline: null,
          expected: STANDALONE_PREVIEW.expected,
        },
      },
    ]);
  });

  it("issues for a tenant without a cabinet from the «Офлайн» terms: a published plan and a term up to a year", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const offlinePreview = {
      ...STANDALONE_PREVIEW,
      previous: null,
      next: {
        ...STANDALONE_PREVIEW.next,
        sequence: 1,
        source: "offline",
        planVersionId: PUBLISHED_PLAN.id,
        entitlementRevision: "0",
        validUntilReason: "offline_term",
      },
      warnings: [],
      expected: { ...STANDALONE_PREVIEW.expected, entitlementRevision: "0", boundaryAt: null },
    };
    const calls = stubApi({
      [`GET ${BASE}`]: [
        () => jsonResponse(200, { ...STANDALONE_SITE_LIST, issuanceSource: "offline" }),
      ],
      ["GET /api/platform/catalog/items"]: [
        () => jsonResponse(200, { items: [PUBLISHED_PLAN, ADDON] }),
      ],
      [PREVIEW]: [() => jsonResponse(200, offlinePreview)],
      [CONFIRM]: [() => jsonResponse(200, STANDALONE_FILE)],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      within(await siteRow()).getByRole("button", {
        name: "Выпустить офлайн-лицензию: Цех розлива",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Выпуск офлайн-лицензии: Цех розлива",
    });
    expect(within(dialog).getByRole("group", { name: "Офлайн" })).toBeDefined();
    const preview = within(dialog).getByRole("button", { name: "Предпросмотр" });
    expect(preview).toHaveProperty("disabled", true);

    await user.click(await within(dialog).findByRole("combobox", { name: "Тариф" }));
    expect(screen.queryByRole("option", { name: /Дополнительная станция/u })).toBeNull();
    await user.click(await screen.findByRole("option", { name: /Базовый · plan-basic/u }));
    const term = within(dialog).getByLabelText("Срок, дней");
    expect(term).toHaveProperty("value", "365");
    await user.clear(term);
    await user.type(term, "366");
    expect(within(dialog).getByText("Целое число от 1 до 365.")).toBeDefined();
    expect(preview).toHaveProperty("disabled", true);
    await user.clear(term);
    await user.type(term, "200");
    await user.click(preview);
    const table = await within(dialog).findByRole("table", { name: "Было → станет" });
    expect(
      within(within(table).getByRole("row", { name: /Основание/u })).getByText("офлайн-условия"),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить и скачать" }));
    await vi.waitFor(() => expect(vi.mocked(saveLicenseFile)).toHaveBeenCalled());
    const offline = { planVersionId: PUBLISHED_PLAN.id, termDays: 200 };
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: PREVIEW, body: { graceDays: null, offline } },
      {
        key: CONFIRM,
        body: {
          requestId: REQUEST_ID,
          graceDays: null,
          offline,
          expected: offlinePreview.expected,
        },
      },
    ]);
  });

  it("tells that a subscription without an end date gives a one-year file, renewed free of charge", async () => {
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [PREVIEW]: [
        () =>
          jsonResponse(200, {
            ...STANDALONE_PREVIEW,
            next: { ...STANDALONE_PREVIEW.next, validUntilReason: "one_year_cap" },
            expected: { ...STANDALONE_PREVIEW.expected, boundaryAt: null },
          }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await user.click(
      within(await siteRow()).getByRole("button", {
        name: "Выпустить офлайн-лицензию: Цех розлива",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Выпуск офлайн-лицензии: Цех розлива",
    });
    expect(within(dialog).queryByRole("group", { name: "Офлайн" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    expect(
      await within(dialog).findByText(
        "Файл действует не дольше года с выпуска (так бывает у подписки без даты окончания или длиннее года). Когда срок выйдет, клиент бесплатно запрашивает у нас новый файл.",
      ),
    ).toBeDefined();
  });

  it("does not offer issuing while license signing is not configured", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        () => jsonResponse(200, { ...STANDALONE_SITE_LIST, signingConfigured: false }),
      ],
    });
    renderPanel();
    expect(
      within(await siteRow()).getByRole("button", {
        name: "Выпустить офлайн-лицензию: Цех розлива",
      }),
    ).toHaveProperty("disabled", true);
  });
});
