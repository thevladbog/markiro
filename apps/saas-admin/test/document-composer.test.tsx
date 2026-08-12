import { readFileSync } from "node:fs";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { NavigationGuardProvider } from "../src/layout/NavigationGuard.js";
import { DocumentComposer } from "../src/pages/documents/DocumentComposer.js";
import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import type { TenantListItem } from "../src/pages/tenants/api.js";

const globalCss = readFileSync("src/global.css", "utf8");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tenant = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Завод Север",
  slug: "sever-factory",
  createdAt: "2026-08-01T00:00:00.000Z",
  subscriptionStatus: "unmanaged",
} satisfies TenantListItem;

const plan = {
  id: "21111111-1111-4111-8111-111111111111",
  catalogItemId: "31111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  kind: "plan",
  version: 3,
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
  publishedByPlatformUserId: "41111111-1111-4111-8111-111111111111",
  plan: {
    maxLines: null,
    maxStations: null,
    maxKiosks: null,
    maxCabinetUsers: null,
    labelEditorEnabled: false,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: null,
  },
} satisfies CatalogVersionDto;

const addon = {
  ...plan,
  id: "22222222-1111-4111-8111-111111111111",
  catalogItemId: "32222222-1111-4111-8111-111111111111",
  catalogItemCode: "addon-lines",
  kind: "addon",
  nameRu: "Дополнительные линии",
  nameEn: "Extra lines",
  unit: "линия",
  unitPrice: "100.00",
  vatIncluded: false,
  addon: { effects: [{ key: "lines", quotaIncrement: 10 }] },
} satisfies CatalogVersionDto;

const service = {
  ...plan,
  id: "23333333-1111-4111-8111-111111111111",
  catalogItemId: "33333333-1111-4111-8111-111111111111",
  catalogItemCode: "service-launch",
  kind: "service",
  nameRu: "Запуск",
  nameEn: "Launch",
  unit: "час",
  billingMode: "one_time",
  billingPeriod: null,
  unitPrice: "0.10",
  vatRateBps: null,
  vatIncluded: false,
  service: {},
} satisfies CatalogVersionDto;

function renderComposer(overrides: Partial<React.ComponentProps<typeof DocumentComposer>> = {}) {
  const props = {
    kind: "invoice" as const,
    tenants: [tenant],
    catalog: [plan, addon, service],
    loadingSources: false,
    submitting: false,
    onSubmit: vi.fn(async () => undefined),
    onCancel: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <NavigationGuardProvider>
            <DocumentComposer {...props} />
          </NavigationGuardProvider>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return {
    ...render(
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>,
    ),
    props,
  };
}

async function selectCombobox(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  search: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.type(screen.getByRole("searchbox"), search);
  await user.click(screen.getByRole("option", { name: new RegExp(`^${option}`) }));
}

describe("DocumentComposer", () => {
  it("keeps a multi-line invoice editable and submits its visible order", async () => {
    await i18n.changeLanguage("ru");
    const user = userEvent.setup();
    const { props, container } = renderComposer();

    await selectCombobox(user, "Тенант", "sever", "Завод Север · sever-factory");
    await selectCombobox(user, "Добавить позицию", "v3", "Базовый тариф · plan-basic · v3");
    await selectCombobox(user, "Добавить позицию", "plan-basic", "Базовый тариф · plan-basic · v3");
    expect((screen.getByLabelText("Количество Базовый тариф") as HTMLInputElement).value).toBe("2");

    await user.click(screen.getByRole("button", { name: "Добавить отдельной строкой" }));
    await selectCombobox(user, "Добавить позицию", "plan-basic", "Базовый тариф · plan-basic · v3");
    await selectCombobox(
      user,
      "Добавить позицию",
      "Дополнительные",
      "Дополнительные линии · addon-lines · v3",
    );
    await selectCombobox(user, "Добавить позицию", "Запуск", "Запуск · service-launch · v3");

    expect(container.querySelector("select:not([aria-hidden])")).toBeNull();
    expect(screen.getAllByRole("combobox", { name: /Политика активации/ })).toHaveLength(3);
    expect(screen.getByText("400.10 ₽")).toBeDefined();
    expect(screen.getByText("80.00 ₽")).toBeDefined();
    expect(screen.getByText("480.10 ₽")).toBeDefined();

    await user.click(
      screen.getAllByRole("combobox", { name: "Политика активации Базовый тариф" })[1]!,
    );
    await user.click(screen.getByRole("option", { name: "Вручную" }));
    await user.clear(screen.getAllByLabelText("Цена Базовый тариф")[1]!);
    await user.type(screen.getAllByLabelText("Цена Базовый тариф")[1]!, "60.00");
    await user.clear(screen.getByLabelText("Количество Запуск"));
    await user.type(screen.getByLabelText("Количество Запуск"), "3");
    await user.clear(screen.getByLabelText("Цена Запуск"));
    await user.type(screen.getByLabelText("Цена Запуск"), "1.00");

    await user.click(screen.getAllByRole("button", { name: "Удалить Базовый тариф" })[0]!);
    await user.click(screen.getByRole("button", { name: "Переместить Запуск вверх" }));
    expect(screen.getByText("153.00 ₽")).toBeDefined();
    expect(screen.getByText("30.00 ₽")).toBeDefined();
    expect(screen.getByText("183.00 ₽")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Переместить Базовый тариф вверх" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Переместить Дополнительные линии вниз",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Создать черновик счёта" }));
    expect(props.onSubmit).toHaveBeenCalledWith({
      tenantId: tenant.id,
      applicationMode: "automatic",
      date: "",
      lines: [
        expect.objectContaining({
          nameRu: "Базовый тариф",
          quantity: 1,
          activationPolicy: "manual",
        }),
        expect.objectContaining({
          nameRu: "Запуск",
          quantity: 3,
          agreedUnitPrice: "1.00",
          activationPolicy: null,
        }),
        expect.objectContaining({ nameRu: "Дополнительные линии", activationPolicy: "immediate" }),
      ],
    });
  });

  it("protects an edited document from an unload", async () => {
    await i18n.changeLanguage("ru");
    const user = userEvent.setup();
    renderComposer();

    await selectCombobox(user, "Добавить позицию", "v3", "Базовый тариф · plan-basic · v3");

    const unload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, unload);

    expect(unload.defaultPrevented).toBe(true);
  });

  it("limits offer policies and preserves every initial value after a submission error", async () => {
    await i18n.changeLanguage("ru");
    const user = userEvent.setup();
    const { props } = renderComposer({
      kind: "offer",
      initialDraft: {
        tenantId: tenant.id,
        applicationMode: "manual",
        date: "2026-09-01",
        lines: [
          {
            id: "plan-line",
            kind: "plan",
            catalogVersionId: plan.id,
            catalogItemCode: plan.catalogItemCode,
            version: plan.version,
            nameRu: plan.nameRu,
            nameEn: plan.nameEn,
            quantity: 2,
            unit: plan.unit,
            agreedUnitPrice: "120.00",
            vatRateBps: 2000,
            vatIncluded: true,
            activationPolicy: "after_current",
          },
          {
            id: "addon-line",
            kind: "addon",
            catalogVersionId: addon.id,
            catalogItemCode: addon.catalogItemCode,
            version: addon.version,
            nameRu: addon.nameRu,
            nameEn: addon.nameEn,
            quantity: 1,
            unit: addon.unit,
            agreedUnitPrice: "100.00",
            vatRateBps: 2000,
            vatIncluded: false,
            activationPolicy: "immediate",
          },
          {
            id: "service-line",
            kind: "service",
            catalogVersionId: service.id,
            catalogItemCode: service.catalogItemCode,
            version: service.version,
            nameRu: service.nameRu,
            nameEn: service.nameEn,
            quantity: 1,
            unit: service.unit,
            agreedUnitPrice: "0.10",
            vatRateBps: null,
            vatIncluded: false,
            activationPolicy: null,
          },
        ],
      },
      submitError: "Черновик не сохранён",
    });

    expect(screen.getByText("Черновик не сохранён")).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Политика активации Базовый тариф" }).textContent,
    ).toContain("После текущего");
    await user.click(screen.getByRole("combobox", { name: "Политика активации Базовый тариф" }));
    expect(screen.getByRole("option", { name: "Немедленно" })).toBeDefined();
    expect(screen.getByRole("option", { name: "После текущего" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Вручную" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Политика активации Запуск" })).toBeNull();
    expect((screen.getByLabelText("Количество Базовый тариф") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Цена Дополнительные линии") as HTMLInputElement).value).toBe(
      "100.00",
    );
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { version: plan, activationPolicy: "manual" as const },
    { version: addon, activationPolicy: "after_current" as const },
  ])(
    "blocks an offer submit when an initial $version.kind uses $activationPolicy",
    async ({ version, activationPolicy }) => {
      await i18n.changeLanguage("ru");
      const user = userEvent.setup();
      const { props } = renderComposer({
        kind: "offer",
        initialDraft: {
          tenantId: tenant.id,
          applicationMode: "manual",
          date: "",
          lines: [
            {
              id: `invalid-${version.kind}`,
              kind: version.kind,
              catalogVersionId: version.id,
              catalogItemCode: version.catalogItemCode,
              version: version.version,
              nameRu: version.nameRu,
              nameEn: version.nameEn,
              quantity: 1,
              unit: version.unit,
              agreedUnitPrice: "120.00",
              vatRateBps: 2000,
              vatIncluded: true,
              activationPolicy,
            },
          ],
        },
      });

      await user.click(screen.getByRole("button", { name: "Создать черновик предложения" }));

      expect(props.onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText("Политика активации недоступна")).toBeDefined();
    },
  );

  it("keeps every line action at the 44px touch target", async () => {
    await i18n.changeLanguage("ru");
    renderComposer({
      initialDraft: {
        tenantId: tenant.id,
        applicationMode: "automatic",
        date: "",
        lines: [
          {
            id: "action-plan",
            kind: "plan",
            catalogVersionId: plan.id,
            catalogItemCode: plan.catalogItemCode,
            version: plan.version,
            nameRu: plan.nameRu,
            nameEn: plan.nameEn,
            quantity: 1,
            unit: plan.unit,
            agreedUnitPrice: "120.00",
            vatRateBps: 2000,
            vatIncluded: true,
            activationPolicy: "immediate",
          },
        ],
      },
    });

    const action = screen.getByRole("button", { name: "Переместить Базовый тариф вверх" });

    expect(action.classList.contains("document-line__action")).toBe(true);
    expect(globalCss).toMatch(/\.document-line__action\s*\{[^}]*width:\s*44px;/);
    expect(globalCss).toMatch(/\.document-line__action\s*\{[^}]*min-width:\s*44px;/);
  });
});
