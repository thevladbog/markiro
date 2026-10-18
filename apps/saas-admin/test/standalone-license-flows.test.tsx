import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import { standaloneSiteInspectRequestSchema } from "@markiro/platform-contracts";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";
import { StandaloneSitesPanel } from "../src/pages/tenants/StandaloneSitesPanel.js";
import { saveLicenseFile } from "../src/pages/tenants/standalone-download.js";
import { jsonResponse, TENANT_DETAIL } from "./render.js";
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

function renderPanel(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ThemeProvider defaultTheme="light">
          <MemoryRouter>
            <StandaloneSitesPanel tenantId={STANDALONE_TENANT_ID} />
          </MemoryRouter>
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
  it.each(["close", "unmount"])(
    "releases the encrypted activation token from the mutation cache after %s",
    async (exit) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const token = "MKS1.test.PRIVATE_ENCRYPTED_USAGE";
      const exported = { ...activationRequest, supportToken: token };
      stubApi({
        [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
        [`POST ${BASE}/inspect`]: [() => jsonResponse(200, STANDALONE_INSPECTION)],
      });
      const view = renderPanel(client);
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
      await user.upload(
        within(dialog).getByTestId("file-drop-input"),
        activationFile(JSON.stringify(exported)),
      );
      await within(dialog).findByLabelText("Название площадки");
      const cached = () =>
        JSON.stringify(
          client
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state),
        );
      expect(cached()).toContain(token);
      if (exit === "close")
        await user.click(within(dialog).getAllByRole("button", { name: "Отмена" })[0]!);
      else view.unmount();
      await vi.waitFor(() => expect(cached()).not.toContain(token));
    },
  );

  it.each(["paste", "file"])(
    "refreshes diagnostics immediately on %s and asks explicitly for an unbound host",
    async (source) => {
      const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
      const exported = { ...activationRequest, supportToken: "MKS1.test.ABC_-12" };
      const calls = stubApi({
        [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
        [`POST ${BASE}/inspect`]: [
          () => jsonResponse(409, { code: "standalone_diagnostics_host_unbound" }),
          () =>
            jsonResponse(200, {
              ...STANDALONE_INSPECTION,
              blocking: "host_registered",
              registeredSite: { id: STANDALONE_SITE_ID, name: "Цех розлива" },
              diagnostics: {
                duplicate: false,
                monthsApplied: 2,
                monthsSkipped: 0,
                diagnostic: {
                  id: "d1111111-1111-4111-8111-111111111111",
                  hostKey: exported.hostId,
                  siteId: STANDALONE_SITE_ID,
                  generatedAt: "2026-10-14T09:00:00.000Z",
                  receivedAt: "2026-10-18T09:00:00.000Z",
                  kid: "test",
                  payloadVersion: 2,
                  appVersion: "0.2.0",
                  hostVersion: "0.2.0",
                  pcRole: "host",
                  os: null,
                  arch: null,
                  webview: null,
                  licenseState: null,
                },
              },
            }),
        ],
      });
      renderPanel();
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Добавить площадку из запроса активации" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Площадка из запроса активации" });
      if (source === "file")
        await user.upload(
          within(dialog).getByTestId("file-drop-input"),
          activationFile(JSON.stringify(exported)),
        );
      else {
        fireEvent.change(within(dialog).getByLabelText("Или вставьте JSON запроса на активацию"), {
          target: { value: JSON.stringify(exported) },
        });
        await user.click(within(dialog).getByRole("button", { name: "Импортировать запрос" }));
      }
      const confirm = await within(dialog).findByRole("button", { name: "Сохранить без привязки" });
      expect(invalidate).not.toHaveBeenCalledWith({
        queryKey: ["platform", "tenants", STANDALONE_TENANT_ID, "standalone-diagnostics"],
      });
      await user.click(confirm);
      expect(
        await within(dialog).findByText("Статистика запроса обработана. Обновлено месяцев: 2."),
      ).toBeDefined();
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["platform", "tenants", STANDALONE_TENANT_ID, "standalone-diagnostics"],
      });
      expect(
        calls.filter((call) => call.key === `POST ${BASE}/inspect`).map((call) => call.body),
      ).toEqual([{ request: exported }, { request: exported, acknowledgeUnboundHost: true }]);
      expect(within(dialog).getByRole("button", { name: "Добавить площадку" })).toHaveProperty(
        "disabled",
        true,
      );
    },
  );

  it("registers a site after the operator acknowledges the INN mismatch", async () => {
    const exported = { ...activationRequest, supportToken: "MKS1.test.PRIVATE_ENCRYPTED_USAGE" };
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
    await user.upload(
      within(dialog).getByTestId("file-drop-input"),
      activationFile(JSON.stringify(exported)),
    );

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
      { key: `POST ${BASE}/inspect`, body: { request: exported } },
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
        "Файл действует не дольше года с выпуска (так бывает у подписки или назначения без даты окончания и у более длинных). Когда срок выйдет, клиент бесплатно запрашивает у нас новый файл.",
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

describe("offline license from the assignments of a tenant without a cabinet (spec 2026-10-16)", () => {
  const PREVIEW = `POST ${BASE}/${STANDALONE_SITE_ID}/issuances/preview`;
  const CONFIRM = `POST ${BASE}/${STANDALONE_SITE_ID}/issuances`;
  const TENANT = `GET /api/platform/tenants/${STANDALONE_TENANT_ID}`;
  const OFFLINE_TENANT = {
    ...structuredClone(TENANT_DETAIL),
    tenant: { ...structuredClone(TENANT_DETAIL.tenant), cabinetAccess: "none" },
    subscriptionStatus: "unmanaged",
    ownerActivation: null,
    currentSubscription: {
      ...structuredClone(TENANT_DETAIL.currentSubscription),
      status: "active",
      source: "manual",
    },
  };
  const assignmentsPreview = {
    ...STANDALONE_PREVIEW,
    next: {
      ...STANDALONE_PREVIEW.next,
      source: "offline_assignments",
      validFrom: new Date().toISOString(),
      validUntilReason: "one_year_cap",
      sourceAssignments: [
        {
          kind: "plan",
          id: OFFLINE_TENANT.currentSubscription.id,
          catalogVersionId: OFFLINE_TENANT.currentSubscription.planVersionId,
        },
        ...OFFLINE_TENANT.activeAddons.map((addon) => ({
          kind: "addon",
          id: addon.id,
          catalogVersionId: addon.addonVersionId,
        })),
      ],
    },
    expected: { ...STANDALONE_PREVIEW.expected, boundaryAt: null },
  };
  const OFFLINE_LIST = { ...STANDALONE_SITE_LIST, issuanceSource: "offline_assignments" };

  async function openIssueDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      within(await siteRow()).getByRole("button", {
        name: "Выпустить офлайн-лицензию: Цех розлива",
      }),
    );
    return screen.findByRole("dialog", { name: "Выпуск офлайн-лицензии: Цех розлива" });
  }

  it("has no manual offline section; shows the assignments and a link to change them", async () => {
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      [TENANT]: [() => jsonResponse(200, OFFLINE_TENANT)],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    expect(within(dialog).queryByRole("group", { name: "Офлайн" })).toBeNull();
    expect(within(dialog).queryByLabelText("Срок, дней")).toBeNull();
    const summary = within(dialog).getByRole("region", { name: "Права из назначений клиента" });
    expect(await within(summary).findByText(/Тариф: Базовый · версия 1/)).toBeDefined();
    expect(within(summary).getByText(/Дополнение: Дополнительная станция/)).toBeDefined();
    expect(
      within(summary).getByRole("link", { name: "Изменить права клиента" }).getAttribute("href"),
    ).toBe(`/tenants/${STANDALONE_TENANT_ID}#tenant-subscription`);
  });

  it("previews and confirms with offline: null and shows the rights table", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_ID);
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      [TENANT]: [() => jsonResponse(200, OFFLINE_TENANT)],
      [PREVIEW]: [() => jsonResponse(200, assignmentsPreview)],
      [CONFIRM]: [() => jsonResponse(200, STANDALONE_FILE)],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    const table = await within(dialog).findByRole("table", { name: "Было → станет" });
    expect(
      within(within(table).getByRole("row", { name: /Основание/u })).getByText(
        "назначения клиента",
      ),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить и скачать" }));
    await vi.waitFor(() => expect(vi.mocked(saveLicenseFile)).toHaveBeenCalled());
    expect(calls.filter((call) => call.key.startsWith("POST"))).toEqual([
      { key: PREVIEW, body: { graceDays: null, offline: null } },
      {
        key: CONFIRM,
        body: {
          requestId: REQUEST_ID,
          graceDays: null,
          offline: null,
          expected: assignmentsPreview.expected,
        },
      },
    ]);
  });

  it("names what will be issued and lets the operator confirm when the cached assignments match", async () => {
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      [TENANT]: [() => jsonResponse(200, OFFLINE_TENANT)],
      [PREVIEW]: [() => jsonResponse(200, assignmentsPreview)],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    const summary = within(dialog).getByRole("region", { name: "Права из назначений клиента" });
    expect(await within(summary).findByText("Будет выпущена по")).toBeDefined();
    expect(within(summary).getByText(/Тариф: Базовый · версия 1/)).toBeDefined();
    expect(within(summary).getByText(/Дополнение: Дополнительная станция/)).toBeDefined();
    expect(within(dialog).queryByText(/Назначения клиента изменились/)).toBeNull();
    await vi.waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Подтвердить и скачать" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("shows what the preview will issue, warns and blocks confirmation when the plan changed from A to B", async () => {
    const planB = {
      kind: "plan",
      id: "b2222222-2222-4222-8222-222222222222",
      catalogVersionId: "c2222222-2222-4222-8222-222222222222",
    };
    const calls = stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      // The tenant card still shows plan A (and the add-on), also after the refetch.
      [TENANT]: [() => jsonResponse(200, OFFLINE_TENANT)],
      [PREVIEW]: [
        () =>
          jsonResponse(200, {
            ...assignmentsPreview,
            next: { ...assignmentsPreview.next, sourceAssignments: [planB] },
          }),
      ],
      [CONFIRM]: [() => jsonResponse(200, STANDALONE_FILE)],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    const summary = within(dialog).getByRole("region", { name: "Права из назначений клиента" });
    expect(await within(summary).findByText(/Тариф: Базовый · версия 1/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));

    // What will be issued is what the API named, not the cached plan A.
    expect(await within(summary).findByText("Будет выпущена по")).toBeDefined();
    expect(within(summary).getByText(/Тариф · версия c2222222/)).toBeDefined();
    expect(within(summary).queryByText(/Тариф: Базовый · версия 1/)).toBeNull();
    expect(
      await within(dialog).findByText(/Назначения клиента изменились после предпросмотра/),
    ).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Подтвердить и скачать" })).toHaveProperty(
      "disabled",
      true,
    );
    // The tenant was read again after the preview: the comparison is not against a stale cache.
    expect(calls.filter((call) => call.key === TENANT).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.key === CONFIRM)).toEqual([]);
  });

  it("does not report a difference when a scheduled renewal has started but the job has not run", async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const successor = {
      ...structuredClone(OFFLINE_TENANT.currentSubscription),
      id: "b4444444-4444-4444-8444-444444444444",
      status: "scheduled",
      startsAt: hourAgo,
      endsAt: null,
    };
    const successorAddon = {
      ...structuredClone(OFFLINE_TENANT.activeAddons[0]),
      id: "e4444444-4444-4444-8444-444444444444",
      subscriptionId: successor.id,
      status: "scheduled",
      startsAt: hourAgo,
      endsAt: null,
    };
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      [TENANT]: [
        () =>
          jsonResponse(200, {
            ...OFFLINE_TENANT,
            // The old plan ended an hour ago; the status job has not yet promoted the successor.
            currentSubscription: { ...OFFLINE_TENANT.currentSubscription, endsAt: hourAgo },
            activeAddons: [],
            scheduledSubscription: successor,
            scheduledAddons: [successorAddon],
          }),
      ],
      [PREVIEW]: [
        () =>
          jsonResponse(200, {
            ...assignmentsPreview,
            next: {
              ...assignmentsPreview.next,
              sourceAssignments: [
                {
                  kind: "plan",
                  id: successor.id,
                  catalogVersionId: successor.planVersionId,
                },
                {
                  kind: "addon",
                  id: successorAddon.id,
                  catalogVersionId: successorAddon.addonVersionId,
                },
              ],
            },
          }),
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    const summary = within(dialog).getByRole("region", { name: "Права из назначений клиента" });
    expect(await within(summary).findByText("Будет выпущена по")).toBeDefined();
    expect(within(summary).getByText(/Тариф: Базовый · версия 1/)).toBeDefined();
    expect(within(dialog).queryByText(/Назначения клиента изменились/)).toBeNull();
    await vi.waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Подтвердить и скачать" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("does not name an add-on that has not started as a difference", async () => {
    const future = {
      ...structuredClone(OFFLINE_TENANT.activeAddons[0]),
      id: "e3333333-3333-4333-8333-333333333333",
      startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    };
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      [TENANT]: [
        () =>
          jsonResponse(200, {
            ...OFFLINE_TENANT,
            activeAddons: [...OFFLINE_TENANT.activeAddons, future],
          }),
      ],
      [PREVIEW]: [() => jsonResponse(200, assignmentsPreview)],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    expect(await within(dialog).findByText("Будет выпущена по")).toBeDefined();
    expect(within(dialog).queryByText(/Назначения клиента изменились/)).toBeNull();
  });

  it("says that an assignment is missing and links to the rights of the tenant", async () => {
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, OFFLINE_LIST)],
      [TENANT]: [
        () =>
          jsonResponse(200, {
            ...OFFLINE_TENANT,
            currentSubscription: null,
            activeAddons: [],
          }),
      ],
      [PREVIEW]: [() => jsonResponse(409, { code: "standalone_license_assignments_required" })],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    expect(
      await within(dialog).findByText(
        "У клиента нет действующего тарифа. Назначьте тариф с пометкой «Доступно офлайн-клиентам».",
      ),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    expect(
      await within(dialog).findByText(
        "Нет действующего назначения тарифа. Измените права клиента.",
      ),
    ).toBeDefined();
    const links = within(dialog).getAllByRole("link", { name: "Изменить права клиента" });
    expect(links).toHaveLength(2);
    for (const link of links)
      expect(link.getAttribute("href")).toBe(
        `/tenants/${STANDALONE_TENANT_ID}#tenant-subscription`,
      );
  });

  it("tells an old cached build that the manual terms are gone", async () => {
    stubApi({
      [`GET ${BASE}`]: [() => jsonResponse(200, STANDALONE_SITE_LIST)],
      [PREVIEW]: [() => jsonResponse(409, { code: "standalone_license_offline_terms_removed" })],
    });
    renderPanel();
    const user = userEvent.setup();
    const dialog = await openIssueDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Предпросмотр" }));
    expect(
      await within(dialog).findByText(
        "Ручные офлайн-условия больше не поддерживаются. Обновите страницу.",
      ),
    ).toBeDefined();
  });
});
