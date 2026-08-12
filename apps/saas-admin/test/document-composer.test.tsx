import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import "../src/i18n/index.js";
import { NavigationGuardProvider } from "../src/layout/NavigationGuard.js";
import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import { DocumentComposer } from "../src/pages/documents/DocumentComposer.js";
import type { DocumentDraft } from "../src/pages/documents/documentDraft.js";
import type { TenantListItem } from "../src/pages/tenants/api.js";

const tenants = [
  {
    id: "41111111-1111-4111-8111-111111111111",
    name: "Северный завод",
    slug: "sever-factory",
    createdAt: "2026-08-01T00:00:00.000Z",
    subscriptionStatus: "active",
  },
  {
    id: "42222222-2222-4222-8222-222222222222",
    name: "Тульский комбинат",
    slug: "tula-plant",
    createdAt: "2026-08-02T00:00:00.000Z",
    subscriptionStatus: "unmanaged",
  },
] satisfies TenantListItem[];

const plan = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  kind: "plan",
  version: 2,
  status: "published",
  nameRu: "Базовый тариф",
  nameEn: "Basic plan",
  descriptionRu: null,
  descriptionEn: null,
  unit: "месяц",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "120.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedAt: "2026-08-01T00:00:00.000Z",
  publishedByPlatformUserId: "user-1",
  plan: {
    maxLines: 1,
    maxStations: 1,
    maxKiosks: 1,
    maxCabinetUsers: 1,
    labelEditorEnabled: false,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: null,
  },
} satisfies CatalogVersionDto;

const { plan: _plan, ...catalogBase } = plan;
void _plan;

const addon = {
  ...catalogBase,
  id: "12222222-2222-4222-8222-222222222222",
  catalogItemId: "22222222-2222-4222-8222-222222222222",
  catalogItemCode: "addon-lines",
  kind: "addon",
  version: 1,
  nameRu: "Дополнительные линии",
  nameEn: "Additional lines",
  unit: "линия",
  unitPrice: "100.00",
  vatIncluded: false,
  addon: { effects: [{ key: "lines", quotaIncrement: 10 }] },
} satisfies CatalogVersionDto;

const service = {
  ...catalogBase,
  id: "13333333-3333-4333-8333-333333333333",
  catalogItemId: "23333333-3333-4333-8333-333333333333",
  catalogItemCode: "service-training",
  kind: "service",
  version: 3,
  nameRu: "Обучение операторов",
  nameEn: "Operator training",
  unit: "час",
  billingMode: "one_time",
  billingPeriod: null,
  unitPrice: "0.10",
  vatRateBps: null,
  vatIncluded: false,
  service: {},
} satisfies CatalogVersionDto;

const catalog = [plan, addon, service] satisfies CatalogVersionDto[];

afterEach(() => cleanup());

function renderComposer(node: ReactNode) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <ThemeProvider defaultTheme="light">
            <NavigationGuardProvider>{node}</NavigationGuardProvider>
          </ThemeProvider>
        ),
      },
      { path: "/next", element: <div>Следующий экран</div> },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

async function chooseCombobox(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  query: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  const search = screen.getByRole("searchbox");
  await user.clear(search);
  await user.type(search, query);
  await user.click(screen.getByRole("option", { name: new RegExp(option, "i") }));
}

function rowNamed(name: string) {
  return screen.getByText(name, { selector: ".document-line__name" }).closest("tr")!;
}

describe("DocumentComposer", () => {
  it("builds and submits an invoice from searchable catalog lines in visible order", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    renderComposer(
      <DocumentComposer
        kind="invoice"
        tenants={tenants}
        catalog={catalog}
        loadingSources={false}
        submitting={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const linesScrollRegion = screen
      .getAllByRole("region", { name: "Позиции документа" })
      .find((region) => region.classList.contains("document-lines__scroll"));
    expect(linesScrollRegion).toBeTruthy();
    if (!linesScrollRegion) throw new Error("named lines scroll region missing");
    expect(linesScrollRegion.getAttribute("tabindex")).toBe("0");
    linesScrollRegion.focus();
    expect(document.activeElement).toBe(linesScrollRegion);
    expect(screen.getByText("Добавьте первую позицию из каталога")).toBeTruthy();

    await user.click(screen.getByRole("combobox", { name: "Тенант" }));
    await user.type(screen.getByRole("searchbox"), "север");
    expect(screen.getByRole("option", { name: /Северный завод.*sever-factory/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Тульский комбинат/i })).toBeNull();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "sever-factory");
    await user.click(screen.getByRole("option", { name: /Северный завод/i }));

    await chooseCombobox(user, "Добавить позицию", "Базовый", "Базовый тариф");
    await chooseCombobox(user, "Добавить позицию", "addon-lines", "Дополнительные линии");

    await user.click(screen.getByRole("combobox", { name: "Добавить позицию" }));
    await user.type(screen.getByRole("searchbox"), "v3");
    expect(screen.getByRole("option", { name: /Обучение операторов.*v3/i })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: /Обучение операторов/i }));

    await chooseCombobox(user, "Добавить позицию", "plan-basic", "Базовый тариф");
    expect(
      (
        within(rowNamed("Базовый тариф")).getByRole("spinbutton", {
          name: /Количество/i,
        }) as HTMLInputElement
      ).value,
    ).toBe("2");

    await user.click(
      within(rowNamed("Базовый тариф")).getByRole("button", {
        name: "Добавить Базовый тариф отдельной строкой",
      }),
    );
    expect(screen.getAllByText("Базовый тариф", { selector: ".document-line__name" })).toHaveLength(
      2,
    );
    await user.click(screen.getAllByRole("button", { name: "Удалить Базовый тариф" })[1]!);

    const planRow = rowNamed("Базовый тариф");
    const planQuantity = within(planRow).getByRole("spinbutton", { name: /Количество/i });
    await user.clear(planQuantity);
    await user.type(planQuantity, "3");

    const addonRow = rowNamed("Дополнительные линии");
    const addonPrice = within(addonRow).getByRole("textbox", { name: /Цена/i });
    await user.clear(addonPrice);
    await user.type(addonPrice, "50.00");

    expect(
      within(planRow).getByRole("combobox", { name: "Правило применения Базовый тариф" }),
    ).toBeTruthy();
    expect(
      within(addonRow).getByRole("combobox", {
        name: "Правило применения Дополнительные линии",
      }),
    ).toBeTruthy();
    expect(
      within(rowNamed("Обучение операторов")).queryByRole("combobox", {
        name: /Правило применения/i,
      }),
    ).toBeNull();

    await user.click(
      within(rowNamed("Обучение операторов")).getByRole("button", {
        name: "Переместить Обучение операторов вверх",
      }),
    );
    const visibleNames = within(screen.getByRole("table", { name: "Позиции документа" }))
      .getAllByText(/Базовый тариф|Обучение операторов|Дополнительные линии/, {
        selector: ".document-line__name",
      })
      .map((node) => node.textContent);
    expect(visibleNames).toEqual(["Базовый тариф", "Обучение операторов", "Дополнительные линии"]);

    const summary = screen.getByRole("complementary", { name: "Сводка документа" });
    expect(within(summary).getByText("350,10 ₽")).toBeTruthy();
    expect(within(summary).getByText("70,00 ₽")).toBeTruthy();
    expect(within(summary).getByText("420,10 ₽")).toBeTruthy();
    expect(document.querySelector('select:not([aria-hidden="true"])')).toBeNull();

    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      tenantId: tenants[0]!.id,
      applicationMode: "automatic",
      date: "",
      lines: [
        expect.objectContaining({
          catalogVersionId: plan.id,
          quantity: 3,
          agreedUnitPrice: "120.00",
        }),
        expect.objectContaining({
          catalogVersionId: service.id,
          quantity: 1,
          activationPolicy: null,
        }),
        expect.objectContaining({
          catalogVersionId: addon.id,
          quantity: 1,
          agreedUnitPrice: "50.00",
        }),
      ],
    });
  });

  it("uses offer totals and plan policies without exposing manual, and preserves values after a server error", async () => {
    const user = userEvent.setup();
    const offerDraft: DocumentDraft = {
      tenantId: tenants[0]!.id,
      applicationMode: "automatic",
      date: "2026-09-30",
      lines: [
        {
          id: "offer-line",
          kind: "plan",
          catalogVersionId: plan.id,
          catalogItemCode: plan.catalogItemCode,
          version: plan.version,
          nameRu: plan.nameRu,
          nameEn: plan.nameEn,
          descriptionRu: plan.descriptionRu,
          descriptionEn: plan.descriptionEn,
          quantity: 1,
          unit: plan.unit,
          catalogUnitPrice: plan.unitPrice!,
          agreedUnitPrice: "0.03",
          priceOverrideReason: "Test discount",
          vatRateBps: 2000,
          vatIncluded: false,
          activationPolicy: "immediate",
        },
      ],
    };

    function ServerErrorHarness() {
      const [submitError, setSubmitError] = useState<string>();
      return (
        <DocumentComposer
          kind="offer"
          initialDraft={offerDraft}
          tenants={tenants}
          catalog={catalog}
          loadingSources={false}
          submitting={false}
          {...(submitError ? { submitError } : {})}
          onSubmit={async () => {
            setSubmitError("Конфликт версии каталога");
            return false;
          }}
          onCancel={vi.fn()}
        />
      );
    }

    renderComposer(
      <>
        <Link to="/next">Перейти дальше</Link>
        <ServerErrorHarness />
      </>,
    );
    const line = rowNamed("Базовый тариф");
    const policy = within(line).getByRole("combobox", {
      name: "Правило применения Базовый тариф",
    });
    await user.click(policy);
    expect(screen.queryByRole("option", { name: "Вручную" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "После текущей подписки" }));

    const summary = screen.getByRole("complementary", { name: "Сводка документа" });
    expect(within(summary).getByText("0,03 ₽")).toBeTruthy();
    expect(within(summary).getByText("0,01 ₽")).toBeTruthy();
    expect(within(summary).getByText("0,04 ₽")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));
    expect(await screen.findByText("Конфликт версии каталога")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Тенант" }).textContent).toContain(
      "Северный завод",
    );
    expect((within(line).getByRole("textbox", { name: /Цена/i }) as HTMLInputElement).value).toBe(
      "0.03",
    );
    expect(policy.textContent).toContain("После текущей подписки");
    expect(document.querySelector('select:not([aria-hidden="true"])')).toBeNull();

    await user.click(screen.getByRole("link", { name: "Перейти дальше" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByText("Следующий экран")).toBeNull();
  });

  it("shows a fixed immediate-after-payment policy for an offer add-on", () => {
    const draft: DocumentDraft = {
      tenantId: tenants[0]!.id,
      applicationMode: "automatic",
      date: "",
      lines: [
        {
          id: "offer-addon",
          kind: "addon",
          catalogVersionId: addon.id,
          catalogItemCode: addon.catalogItemCode,
          version: addon.version,
          nameRu: addon.nameRu,
          nameEn: addon.nameEn,
          descriptionRu: addon.descriptionRu,
          descriptionEn: addon.descriptionEn,
          quantity: 1,
          unit: addon.unit,
          catalogUnitPrice: addon.unitPrice!,
          agreedUnitPrice: addon.unitPrice!,
          priceOverrideReason: null,
          vatRateBps: addon.vatRateBps!,
          vatIncluded: false,
          activationPolicy: "immediate",
        },
      ],
    };

    renderComposer(
      <DocumentComposer
        kind="offer"
        initialDraft={draft}
        tenants={tenants}
        catalog={catalog}
        loadingSources={false}
        submitting={false}
        onSubmit={vi.fn(async () => undefined)}
        onCancel={vi.fn()}
      />,
    );

    const addonRow = rowNamed("Дополнительные линии");
    expect(within(addonRow).getByText("Сразу после оплаты")).toBeTruthy();
    expect(
      within(addonRow).queryByRole("combobox", {
        name: "Правило применения Дополнительные линии",
      }),
    ).toBeNull();
  });

  it("associates quantity, price, and override-reason errors with their exact inputs", async () => {
    const user = userEvent.setup();
    renderComposer(
      <DocumentComposer
        kind="offer"
        tenants={tenants}
        catalog={catalog}
        loadingSources={false}
        submitting={false}
        onSubmit={vi.fn(async () => undefined)}
        onCancel={vi.fn()}
      />,
    );

    await chooseCombobox(user, "Добавить позицию", "plan-basic", "Базовый тариф");
    const line = rowNamed("Базовый тариф");
    const quantity = within(line).getByRole("spinbutton", { name: /Количество/i });
    const price = within(line).getByRole("textbox", { name: /^Цена/i });
    await user.clear(quantity);
    await user.clear(price);
    await user.type(price, "99");

    const reason = within(line).getByRole("textbox", { name: /Причина изменения цены/i });
    for (const input of [quantity, price, reason]) {
      const describedBy = input.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)).toBeTruthy();
    }
    expect(document.getElementById(quantity.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Количество должно быть целым и не меньше 1",
    );
    expect(document.getElementById(price.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Введите цену с двумя знаками после запятой",
    );
    expect(document.getElementById(reason.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Укажите причину отличия согласованной цены от каталога",
    );
  });

  it("blocks invalid offer policies with their translated errors", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    const invalidOfferDraft: DocumentDraft = {
      tenantId: tenants[0]!.id,
      applicationMode: "automatic",
      date: "",
      lines: [
        {
          id: "invalid-offer-plan",
          kind: "plan",
          catalogVersionId: plan.id,
          catalogItemCode: plan.catalogItemCode,
          version: plan.version,
          nameRu: plan.nameRu,
          nameEn: plan.nameEn,
          descriptionRu: plan.descriptionRu,
          descriptionEn: plan.descriptionEn,
          quantity: 1,
          unit: plan.unit,
          catalogUnitPrice: plan.unitPrice!,
          agreedUnitPrice: plan.unitPrice!,
          priceOverrideReason: null,
          vatRateBps: plan.vatRateBps!,
          vatIncluded: true,
          activationPolicy: "manual",
        },
        {
          id: "invalid-offer-addon",
          kind: "addon",
          catalogVersionId: addon.id,
          catalogItemCode: addon.catalogItemCode,
          version: addon.version,
          nameRu: addon.nameRu,
          nameEn: addon.nameEn,
          descriptionRu: addon.descriptionRu,
          descriptionEn: addon.descriptionEn,
          quantity: 1,
          unit: addon.unit,
          catalogUnitPrice: addon.unitPrice!,
          agreedUnitPrice: addon.unitPrice!,
          priceOverrideReason: null,
          vatRateBps: addon.vatRateBps!,
          vatIncluded: false,
          activationPolicy: "after_current",
        },
      ],
    };

    renderComposer(
      <DocumentComposer
        kind="offer"
        initialDraft={invalidOfferDraft}
        tenants={tenants}
        catalog={catalog}
        loadingSources={false}
        submitting={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getAllByText("Выбранное правило применения не поддерживается").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Дополнение в предложении должно применяться сразу после оплаты").length,
    ).toBeGreaterThan(0);
    const submit = screen.getByRole("button", { name: "Создать черновик предложения" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("locks tenant selection while submission is in flight", async () => {
    const user = userEvent.setup();
    const validDraft: DocumentDraft = {
      tenantId: tenants[0]!.id,
      applicationMode: "automatic",
      date: "",
      lines: [
        {
          id: "in-flight-plan",
          kind: "plan",
          catalogVersionId: plan.id,
          catalogItemCode: plan.catalogItemCode,
          version: plan.version,
          nameRu: plan.nameRu,
          nameEn: plan.nameEn,
          descriptionRu: plan.descriptionRu,
          descriptionEn: plan.descriptionEn,
          quantity: 1,
          unit: plan.unit,
          catalogUnitPrice: plan.unitPrice!,
          agreedUnitPrice: plan.unitPrice!,
          priceOverrideReason: null,
          vatRateBps: plan.vatRateBps!,
          vatIncluded: true,
          activationPolicy: "immediate",
        },
      ],
    };

    function InFlightHarness() {
      const [submitting, setSubmitting] = useState(false);
      return (
        <DocumentComposer
          kind="invoice"
          initialDraft={validDraft}
          tenants={tenants}
          catalog={catalog}
          loadingSources={false}
          submitting={submitting}
          onSubmit={() => {
            setSubmitting(true);
            return new Promise<void>(() => undefined);
          }}
          onCancel={vi.fn()}
        />
      );
    }

    renderComposer(<InFlightHarness />);
    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));

    const tenantPicker = screen.getByRole("combobox", { name: "Тенант" });
    await waitFor(() => expect((tenantPicker as HTMLButtonElement).disabled).toBe(true));
    await user.click(tenantPicker);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(tenantPicker.textContent).toContain("Северный завод");
  });
});
