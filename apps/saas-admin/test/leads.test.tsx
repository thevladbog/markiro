import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";
import {
  ANONYMIZED_LEAD_DETAIL,
  installLeadsApi,
  LEAD_DETAIL,
  LEAD_ID,
  LEAD_INN,
  LEAD_LIST_ITEM,
} from "./leads-fixtures.js";
import {
  ACCOUNTANT_ME,
  PLATFORM_ADMIN_ME,
  renderSaasApp,
  SUPPORT_ME,
  TENANT_ID,
} from "./render.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

const LEADS_LINK = /^Заявки с сайта/;

describe("leads rail entry", () => {
  it("shows the new-lead count with an accessible name", async () => {
    installLeadsApi({ summary: { newCount: 3 } });
    renderSaasApp({ initialEntry: "/leads" });

    const link = await screen.findByRole("link", { name: "Заявки с сайта, 3 новых" });
    expect(link.getAttribute("href")).toBe("/leads");
    expect(within(link).getByText("3", { selector: "[aria-hidden='true']" })).toBeDefined();
  });

  it("omits the badge when nothing is new and when the summary fails", async () => {
    installLeadsApi({ summary: { newCount: 0 } });
    const first = renderSaasApp({ initialEntry: "/leads" });
    expect(await screen.findByRole("heading", { level: 1, name: "Заявки с сайта" })).toBeDefined();
    await waitFor(() =>
      expect(first.queryClient.getQueryData(["platform", "leads", "summary"])).toEqual({
        newCount: 0,
      }),
    );
    expect(
      screen
        .getByRole("link", { name: "Заявки с сайта" })
        .querySelector(".mk-operational-rail__badge"),
    ).toBeNull();
    first.unmount();

    installLeadsApi({ summaryStatus: 503 });
    const second = renderSaasApp({ initialEntry: "/leads" });
    expect(await screen.findByRole("heading", { level: 1, name: "Заявки с сайта" })).toBeDefined();
    await waitFor(() =>
      expect(second.queryClient.getQueryState(["platform", "leads", "summary"])?.status).toBe(
        "error",
      ),
    );
    expect(
      screen
        .getByRole("link", { name: "Заявки с сайта" })
        .querySelector(".mk-operational-rail__badge"),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides the entry and skips the summary without leads.read", async () => {
    const api = installLeadsApi({ me: ACCOUNTANT_ME });
    renderSaasApp({ initialEntry: "/invoices" });

    await screen.findByRole("navigation", { name: "Разделы платформы" });
    expect(screen.queryByRole("link", { name: LEADS_LINK })).toBeNull();
    expect(api.calls.some((call) => call.url.includes("/leads"))).toBe(false);
  });
});

describe("leads list", () => {
  it("builds the request from the URL filters and opens the card from a row", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({
      initialEntry:
        "/leads?search=pivo&status=new&kind=invoice_request&from=2026-10-01&to=2026-10-20",
    });

    expect(await screen.findByText("ООО «Пивоварня»")).toBeDefined();
    expect(api.calls.map((call) => call.url)).toContain(
      "/api/platform/leads?page=1&limit=50&search=pivo&status=new&kind=invoice_request&from=2026-10-01&to=2026-10-20",
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("Запрос счёта")).toBeDefined();
    expect(within(table).getByText("start")).toBeDefined();
    expect(within(table).getByText("Новая")).toBeDefined();
    expect(within(table).getByText("24 окт. 2026 г.")).toBeDefined();

    await user.click(screen.getByRole("link", { name: /ООО «Пивоварня»/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "ООО «Пивоварня»" })).toBeDefined();
  });

  it("sends the search box and the status filter to the server", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/leads" });
    await screen.findByText("ООО «Пивоварня»");

    await user.type(screen.getByLabelText("Компания, почта или ИНН"), LEAD_INN);
    await waitFor(() =>
      expect(api.calls.map((call) => call.url)).toContain(
        `/api/platform/leads?page=1&limit=50&search=${LEAD_INN}`,
      ),
    );

    await user.click(screen.getByLabelText("Статус", { selector: 'button[role="combobox"]' }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", { name: "Счёт выставлен" }),
    );
    await waitFor(() =>
      expect(api.calls.map((call) => call.url)).toContain(
        `/api/platform/leads?page=1&limit=50&search=${LEAD_INN}&status=invoice_sent`,
      ),
    );
  });

  it("keeps typed search text when another filter changes before the debounce", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/leads" });
    await screen.findByText("ООО «Пивоварня»");

    const search = screen.getByLabelText("Компания, почта или ИНН") as HTMLInputElement;
    await user.type(search, "pivo");
    await user.click(screen.getByLabelText("Статус", { selector: 'button[role="combobox"]' }));
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", { name: "Счёт выставлен" }),
    );
    expect(search.value).toBe("pivo");
    await waitFor(() =>
      expect(api.calls.map((call) => call.url)).toContain(
        "/api/platform/leads?page=1&limit=50&search=pivo&status=invoice_sent",
      ),
    );
  });

  it("shows an empty state when nothing matches", async () => {
    installLeadsApi({ list: { items: [], total: 0, page: 1, limit: 50 } });
    renderSaasApp({ initialEntry: "/leads" });

    expect(await screen.findByText("Заявок пока нет")).toBeDefined();
  });
});

describe("lead card", () => {
  it("marks the lead as contacted", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Написал" }));

    await waitFor(() =>
      expect(api.writes()).toEqual([
        { url: `/api/platform/leads/${LEAD_ID}/contacted`, method: "POST", body: {} },
      ]),
    );
    expect(await screen.findByText("27 октября 2026")).toBeDefined();
  });

  it("changes the status, saves the note and the next touch date", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });
    await screen.findByRole("heading", { level: 1, name: "ООО «Пивоварня»" });

    await user.click(
      screen.getByLabelText("Статус заявки", { selector: 'button[role="combobox"]' }),
    );
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", { name: "Пробный период" }),
    );
    await waitFor(() =>
      expect(api.writes().at(-1)).toEqual({
        url: `/api/platform/leads/${LEAD_ID}`,
        method: "PATCH",
        body: { status: "trial" },
      }),
    );

    await user.type(screen.getByLabelText("Заметка"), "Перезвонить в пятницу");
    await user.click(screen.getByRole("button", { name: "Сохранить заметку" }));
    await waitFor(() =>
      expect(api.writes().at(-1)).toEqual({
        url: `/api/platform/leads/${LEAD_ID}`,
        method: "PATCH",
        body: { ownerNote: "Перезвонить в пятницу" },
      }),
    );

    await user.click(screen.getByLabelText("Следующий контакт"));
    await user.click(await screen.findByRole("button", { name: "30 октября 2026" }));
    await user.click(screen.getByRole("button", { name: "Сохранить дату" }));
    await waitFor(() =>
      expect(api.writes().at(-1)).toEqual({
        url: `/api/platform/leads/${LEAD_ID}`,
        method: "PATCH",
        body: { nextTouchAt: "2026-10-30T06:00:00.000Z" },
      }),
    );
  });

  it("shows contacts, source details and the journal", async () => {
    installLeadsApi();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });
    await screen.findByRole("heading", { level: 1, name: "ООО «Пивоварня»" });

    expect(
      screen.getByRole("link", { name: "buyer@pivovarnya.example" }).getAttribute("href"),
    ).toBe("mailto:buyer@pivovarnya.example");
    expect(screen.getByRole("button", { name: "Скопировать почту" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Скопировать телефон" })).toBeDefined();
    expect(screen.getAllByText("source=yandex · medium=cpc").length).toBeGreaterThan(0);
    expect(screen.getByText("https://ya.ru/")).toBeDefined();

    const journal = within(screen.getByRole("list", { name: "Журнал заявки" }));
    const entries = journal.getAllByRole("listitem");
    expect(entries).toHaveLength(3);
    expect(entries[0]?.textContent).toContain("Смена статуса");
    expect(entries[0]?.textContent).toContain("Новая → Написали");
    expect(entries[0]?.textContent).toContain("Оператор платформы");
    expect(entries[1]?.textContent).toContain("Запрос счёта");
    expect(entries[1]?.textContent).toContain("unexpectedKey");
    expect(entries[2]?.textContent).toContain("Скачивание");
    expect(entries[2]?.textContent).toContain("Форма на сайте");
  });

  it("names a lead from the invoice form, which gives no company", async () => {
    installLeadsApi({
      list: { items: [{ ...LEAD_LIST_ITEM, company: null }], total: 1, page: 1, limit: 50 },
      detail: { ...LEAD_DETAIL, company: null },
    });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: "/leads" });

    await user.click(await screen.findByRole("link", { name: /Компания не указана/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Компания не указана" }),
    ).toBeDefined();
    await user.click(await screen.findByRole("button", { name: "Создать клиента без кабинета" }));
    expect((screen.getByLabelText(/^Название/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe(`inn-${LEAD_INN}`);
  });

  it("creates a tenant without a cabinet prefilled from the lead", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Создать клиента без кабинета" }));
    expect((screen.getByLabelText(/^Название/) as HTMLInputElement).value).toBe("ООО «Пивоварня»");
    expect((screen.getByLabelText(/^Slug/) as HTMLInputElement).value).toBe(`inn-${LEAD_INN}`);
    await user.click(screen.getByRole("button", { name: "Создать клиента" }));

    await waitFor(() =>
      expect(api.writes()).toEqual([
        {
          url: `/api/platform/leads/${LEAD_ID}/create-tenant`,
          method: "POST",
          body: { tenantName: "ООО «Пивоварня»", tenantSlug: `inn-${LEAD_INN}` },
        },
      ]),
    );
    const tenantLink = await screen.findByRole("link", { name: "ООО «Пивоварня»" });
    expect(tenantLink.getAttribute("href")).toBe(`/tenants/${TENANT_ID}`);
  });

  it("validates the tenant slug before sending", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Создать клиента без кабинета" }));
    await user.clear(screen.getByLabelText(/^Slug/));
    await user.type(screen.getByLabelText(/^Slug/), "Плохой адрес");
    await user.click(screen.getByRole("button", { name: "Создать клиента" }));

    expect(await screen.findByText(/латинские буквы, цифры и дефисы/)).toBeDefined();
    expect(api.writes()).toEqual([]);
  });

  it("links the lead to an existing tenant", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Связать с существующим" }));
    await user.click(await screen.findByRole("combobox", { name: "Клиент" }));
    await user.click(await screen.findByRole("option", { name: /Первый завод/ }));
    await user.click(screen.getByRole("button", { name: "Связать" }));

    await waitFor(() =>
      expect(api.writes()).toEqual([
        {
          url: `/api/platform/leads/${LEAD_ID}/link-tenant`,
          method: "POST",
          body: { tenantId: TENANT_ID },
        },
      ]),
    );
    expect(await screen.findByRole("link", { name: "Первый завод" })).toBeDefined();
  });

  it("anonymizes only after confirmation", async () => {
    const api = installLeadsApi();
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Обезличить" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(api.writes()).toEqual([]);
    await user.click(dialog.getByRole("button", { name: "Обезличить" }));

    await waitFor(() =>
      expect(api.writes()).toEqual([
        { url: `/api/platform/leads/${LEAD_ID}/anonymize`, method: "POST", body: undefined },
      ]),
    );
    expect(await screen.findByText(/Контакты обезличены/)).toBeDefined();
    expect(screen.queryByRole("link", { name: "buyer@pivovarnya.example" })).toBeNull();
  });

  it("keeps the loaded card when the refetch after a write fails", async () => {
    const api = installLeadsApi({ detailFailsAfterWrite: true });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Написал" }));
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === "GET" && call.url === `/api/platform/leads/${LEAD_ID}`,
        ).length,
      ).toBeGreaterThan(1),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "ООО «Пивоварня»" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Написал" })).toBeDefined();
  });

  it("opens the anonymize dialog without an earlier action's error", async () => {
    installLeadsApi({ mutationStatus: 409, mutationError: "lead_anonymized" });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Написал" }));
    expect(await screen.findByText("Контакты этой заявки обезличены.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Обезличить" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.queryByText("Контакты этой заявки обезличены.")).toBeNull();
  });

  it("shows the server reason when an action is refused", async () => {
    installLeadsApi({ mutationStatus: 409, mutationError: "lead_anonymized" });
    const user = userEvent.setup();
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    await user.click(await screen.findByRole("button", { name: "Написал" }));
    expect(await screen.findByText("Контакты этой заявки обезличены.")).toBeDefined();
  });

  it("hides write controls for support", async () => {
    const api = installLeadsApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });
    await screen.findByRole("heading", { level: 1, name: "ООО «Пивоварня»" });

    const main = within(screen.getByRole("main"));
    expect(main.queryByRole("button", { name: "Написал" })).toBeNull();
    expect(main.queryByRole("button", { name: "Сохранить заметку" })).toBeNull();
    expect(main.queryByRole("button", { name: "Сохранить дату" })).toBeNull();
    expect(main.queryByRole("button", { name: "Обезличить" })).toBeNull();
    expect(main.queryByRole("button", { name: "Создать клиента без кабинета" })).toBeNull();
    expect(main.queryByRole("button", { name: "Связать с существующим" })).toBeNull();
    expect(main.queryByRole("combobox", { name: "Статус заявки" })).toBeNull();
    expect(main.queryByRole("textbox")).toBeNull();
    expect(main.getByText("Новая")).toBeDefined();
    expect(main.getByText("Клиент не связан")).toBeDefined();
    expect(api.calls.some((call) => call.url.startsWith("/api/platform/tenants"))).toBe(false);
  });

  it("hides contacts of an anonymized lead", async () => {
    installLeadsApi({ detail: ANONYMIZED_LEAD_DETAIL });
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });
    await screen.findByRole("heading", { level: 1, name: "ООО «Пивоварня»" });

    expect(screen.getByText(/Контакты обезличены/)).toBeDefined();
    expect(screen.queryByRole("link", { name: /mailto|@/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Скопировать почту" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Написал" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Обезличить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить заметку" })).toBeNull();
    expect(screen.getByText(/Обезличивание/)).toBeDefined();
  });

  it("renders the card in English", async () => {
    await i18n.changeLanguage("en");
    installLeadsApi({ me: PLATFORM_ADMIN_ME, detail: { ...LEAD_DETAIL, events: [] } });
    renderSaasApp({ initialEntry: `/leads/${LEAD_ID}` });

    expect(await screen.findByRole("button", { name: "Mark as contacted" })).toBeDefined();
    expect(screen.getByRole("link", { name: /^Leads/ })).toBeDefined();
  });
});
