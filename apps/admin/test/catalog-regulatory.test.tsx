import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CABINET_CAPABILITY, type CategoryAttributeDefinition } from "@markiro/domain";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import {
  profileSchema,
  type RegulatoryProfile,
  type CategoryProposal,
} from "../src/pages/catalog/regulatory/api.js";
import { ProductRegulatorySections } from "../src/pages/catalog/regulatory/ProductRegulatorySections.js";
import {
  product,
  profile,
  readiness,
  PRODUCT_ID,
  SCHEMA_ID,
  PROPOSAL_ID,
} from "./catalog-regulatory-fixtures.js";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function mount(
  options: {
    group?: number;
    readonly?: boolean;
    unbound?: boolean;
    stale?: boolean;
    conflictOnce?: boolean;
    customProfile?: RegulatoryProfile;
    mapping?: "exact" | "ambiguous";
    entries?: CategoryProposal["diff"]["entries"];
    emptyCategories?: boolean;
  } = {},
) {
  const group = options.group ?? 23;
  const body = options.unbound
    ? { ...profile(group), binding: null, definition: null, values: [] }
    : (options.customProfile ?? profile(group));
  const writes: { url: string; body: unknown }[] = [];
  const requests: string[] = [];
  let failProfile = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (init?.method && init.method !== "GET") {
        const sent: unknown = JSON.parse(String(init.body));
        writes.push({ url, body: sent });
        if (/category-(binding|change)-previews$/.test(url))
          return response({
            proposalId: PROPOSAL_ID,
            baseRevision: options.unbound ? 0 : 4,
            diff: {
              version: 1,
              kind: options.unbound ? "category_binding" : "category_change",
              target: {
                schemaVersionId: SCHEMA_ID,
                categoryId: String(group),
                categoryName: product(group).name,
                tnVedCode: null,
                okpd2Code: null,
              },
              entries: options.entries ?? [],
            },
          });
        if (options.stale || (options.conflictOnce && writes.length === 1))
          return response({ code: "PRODUCT_REGULATORY_REVISION_STALE" }, 409);
        return response({ ...body, binding: { ...profile(group).binding, revision: 5 } });
      }
      if (url.endsWith("/regulatory-profile"))
        return failProfile
          ? response({ message: "Unavailable" }, 503)
          : response(
              options.conflictOnce && writes.length > 0
                ? { ...body, binding: { ...profile(group).binding, revision: 9 } }
                : body,
            );
      if (url.endsWith("/readiness")) return response(readiness);
      if (url.endsWith("/regulatory-category-options"))
        return response({
          items: options.emptyCategories
            ? []
            : [
                {
                  schemaVersionId: SCHEMA_ID,
                  categoryId: String(group),
                  categoryName: "Категория примера",
                  selectors: {},
                  mappingState: options.mapping ?? "exact",
                },
              ],
        });
      return response({ items: [] });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onDirtyChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <AccessProvider
        value={{
          roles: ["manager"],
          capabilities: options.readonly
            ? [CABINET_CAPABILITY.OPERATIONS_READ]
            : [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
        }}
      >
        <MemoryRouter>
          <ProductRegulatorySections product={product(group)} onDirtyChange={onDirtyChange} />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
  return {
    writes,
    requests,
    client,
    onDirtyChange,
    failProfileRead: () => {
      failProfile = true;
    },
    user: userEvent.setup(),
  };
}
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it.each([23, 33, 35])(
  "renders the pinned category and units for group %s, independently of production status",
  async (group) => {
    mount({ group });
    expect(await screen.findByRole("heading", { name: "Готовность" })).toBeDefined();
    expect(await screen.findByLabelText(group === 33 ? "Масса нетто" : "Объём")).toHaveProperty(
      "value",
      "500",
    );
    expect(screen.getByText("Заказ кодов")).toBeDefined();
    expect(screen.getByText("Ввод в оборот")).toBeDefined();
    expect(screen.queryByLabelText("Код АП ЕГАИС")).toBeNull();
  },
);
it("preserves hidden stored attributes and sends only changed visible fields with the captured revision", async () => {
  const { user, writes } = mount();
  const quantity = await screen.findByLabelText("Объём");
  expect(screen.queryByLabelText("Наименования подсластителей")).toBeNull();
  await user.clear(quantity);
  await user.type(quantity, "750");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        url: `/api/products/${PRODUCT_ID}/regulatory-attributes`,
        body: {
          baseRevision: 4,
          values: [
            { attributeId: "quantity", value: { type: "decimal", value: "750", unit: "мл" } },
          ],
        },
      },
    ]),
  );
});
it("reveals a conditional stored field without erasing it when its trigger turns off", async () => {
  const { user, writes } = mount();
  const trigger = await screen.findByLabelText("Содержит подсластитель");
  await user.selectOptions(trigger, "true");
  expect(await screen.findByDisplayValue("Стевия")).toBeDefined();
  await user.selectOptions(trigger, "false");
  const quantity = screen.getByLabelText("Объём");
  await user.clear(quantity);
  await user.type(quantity, "600");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() =>
    expect(writes[0]?.body).toEqual({
      baseRevision: 4,
      values: [{ attributeId: "quantity", value: { type: "decimal", value: "600", unit: "мл" } }],
    }),
  );
});
it("retains dirty input when background data changes and keeps its old revision for conflict detection", async () => {
  const { user, writes, client } = mount({ stale: true });
  const quantity = await screen.findByLabelText("Объём");
  await user.clear(quantity);
  await user.type(quantity, "800");
  client.setQueryData(["products", PRODUCT_ID, "regulatory-profile"], {
    ...profile(),
    binding: { ...profile().binding, revision: 9 },
  });
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() => expect(writes[0]?.body).toMatchObject({ baseRevision: 4 }));
  expect(screen.getByLabelText("Объём")).toHaveProperty("value", "800");
  expect(await screen.findByText(/Карточка изменилась/)).toBeDefined();
});
it("requires explicit review and confirmation to bind a category", async () => {
  const { user, writes } = mount({ unbound: true });
  await user.click(await screen.findByRole("button", { name: "Выбрать категорию" }));
  await user.click(
    await screen.findByRole("combobox", { name: "Категория Национального каталога" }),
  );
  await user.click(screen.getByRole("option", { name: "Категория примера" }));
  await user.click(screen.getByRole("button", { name: "Проверить изменения" }));
  expect(await screen.findByRole("button", { name: "Подтвердить категорию" })).toBeDefined();
  expect(writes).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Подтвердить категорию" }));
  await waitFor(() =>
    expect(writes[1]).toEqual({
      url: `/api/products/${PRODUCT_ID}/regulatory-proposals/${PROPOSAL_ID}/apply`,
      body: { acceptedEntryIds: [] },
    }),
  );
});
it("searches categories with the shared custom select", async () => {
  const { user, writes } = mount({ unbound: true });
  await user.click(await screen.findByRole("button", { name: "Выбрать категорию" }));
  await user.click(
    await screen.findByRole("combobox", { name: "Категория Национального каталога" }),
  );
  const search = await screen.findByRole("searchbox", { name: "Поиск категории" });
  await user.type(search, "несуществующая");
  expect(screen.queryByRole("option", { name: "Категория примера" })).toBeNull();
  await user.clear(search);
  await user.type(search, "примера");
  await user.click(screen.getByRole("option", { name: "Категория примера" }));
  expect(writes).toEqual([]);
});

it("does not open an empty editor or lock product saving when no categories are available", async () => {
  const { onDirtyChange } = mount({ unbound: true, emptyCategories: true });
  expect(await screen.findByText(/Обратитесь в поддержку Markiro/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Выбрать категорию" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Категория Национального каталога" })).toBeNull();
  expect(screen.queryByLabelText("ТН ВЭД")).toBeNull();
  expect(onDirtyChange).not.toHaveBeenCalledWith(true);
});

it("shows data but no mutation controls without write permission", async () => {
  const { writes } = mount({ readonly: true });
  expect(await screen.findByRole("heading", { name: "Характеристики категории" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Сохранить характеристики" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Сменить категорию" })).toBeNull();
  expect(writes).toEqual([]);
});

it("clears an explicitly emptied numeric value without guessing a replacement unit", async () => {
  const { user, writes } = mount();
  await user.clear(await screen.findByLabelText("Объём"));
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() =>
    expect(writes[0]?.body).toEqual({
      baseRevision: 4,
      values: [{ attributeId: "quantity", value: null }],
    }),
  );
});
it("does not accept a missing unit on a numeric field and retains the entered amount", async () => {
  const { user, writes } = mount();
  await user.selectOptions(await screen.findByLabelText("Единица измерения: Объём"), "");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  expect(await screen.findByText("Проверьте значение, формат и единицу измерения.")).toBeDefined();
  expect(writes).toEqual([]);
  expect(screen.getByLabelText("Объём")).toHaveProperty("value", "500");
});
it("edits string, date, enum and repeated enum values according to the pinned schema", async () => {
  const pinned = profileSchema.parse(profile());
  const fields: CategoryAttributeDefinition[] = [
    {
      id: "brand",
      label: "Бренд",
      valueType: "string",
      multiplicity: "one",
      unit: null,
      requirementRules: [],
      presetMode: "none",
      presets: [],
    },
    {
      id: "date",
      label: "Дата документа",
      valueType: "date",
      multiplicity: "one",
      unit: null,
      requirementRules: [],
      presetMode: "none",
      presets: [],
    },
    {
      id: "kind",
      label: "Вид упаковки",
      valueType: "enum",
      multiplicity: "one",
      unit: null,
      requirementRules: [],
      presetMode: "restricted",
      presets: [{ value: "bottle", label: "Бутылка" }],
    },
    {
      id: "materials",
      label: "Материалы",
      valueType: "enum_list",
      multiplicity: "many",
      unit: null,
      requirementRules: [],
      presetMode: "restricted",
      presets: [
        { value: "glass", label: "Стекло" },
        { value: "plastic", label: "Пластик" },
      ],
    },
  ];
  if (!pinned.definition) throw Error("Fixture schema missing");
  pinned.definition.attributes.push(...fields);
  const { user, writes } = mount({ customProfile: pinned });
  await user.type(await screen.findByLabelText("Бренд"), "Сад");
  // Native date input is filled through the same change boundary as the browser calendar.
  const date = screen.getByLabelText("Дата документа");
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(date, { target: { value: "2026-09-11" } });
  await user.selectOptions(screen.getByLabelText("Вид упаковки"), "bottle");
  await user.selectOptions(screen.getByLabelText("Материалы 1"), "glass");
  await user.click(screen.getByRole("button", { name: "Добавить значение" }));
  await user.selectOptions(screen.getByLabelText("Материалы 2"), "plastic");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() =>
    expect(writes[0]?.body).toEqual({
      baseRevision: 4,
      values: [
        { attributeId: "brand", value: { type: "string", value: "Сад" } },
        { attributeId: "date", value: { type: "date", value: "2026-09-11" } },
        { attributeId: "kind", value: { type: "enum", value: "bottle" } },
        { attributeId: "materials", value: { type: "enum_list", value: ["glass", "plastic"] } },
      ],
    }),
  );
});
it("requires an explicit group-mapping acknowledgement for an ambiguous category", async () => {
  const { user, writes } = mount({ unbound: true, mapping: "ambiguous" });
  await user.click(await screen.findByRole("button", { name: "Выбрать категорию" }));
  await user.click(
    await screen.findByRole("combobox", { name: "Категория Национального каталога" }),
  );
  await user.click(screen.getByRole("option", { name: "Категория примера" }));
  expect(screen.getByRole("button", { name: "Проверить изменения" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "Подтверждаю, что категория подходит выбранной товарной группе ЧЗ.",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Проверить изменения" }));
  await waitFor(() =>
    expect(writes[0]?.body).toMatchObject({ baseRevision: 0, mappingConfirmed: true }),
  );
});
it("reviews and selectively transfers compatible values, while incompatible values remain historical", async () => {
  const transferable = "00000000-0000-4000-8000-000000000041",
    inapplicable = "00000000-0000-4000-8000-000000000042";
  const { user, writes } = mount({
    entries: [
      {
        entryId: transferable,
        target: "attribute",
        targetAttributeId: "quantity",
        targetSchemaVersionId: SCHEMA_ID,
        disposition: "transferable",
        currentValue: { type: "decimal", value: "500", unit: "мл" },
        proposedValue: { type: "decimal", value: "500", unit: "мл" },
      },
      {
        entryId: inapplicable,
        target: "attribute",
        targetAttributeId: "sweet",
        targetSchemaVersionId: SCHEMA_ID,
        disposition: "inapplicable",
        currentValue: { type: "boolean", value: false },
        proposedValue: null,
      },
    ],
  });
  await user.click(await screen.findByRole("button", { name: "Сменить категорию" }));
  await user.click(
    await screen.findByRole("combobox", { name: "Категория Национального каталога" }),
  );
  await user.click(screen.getByRole("option", { name: "Категория примера" }));
  await user.click(screen.getByRole("button", { name: "Проверить изменения" }));
  const toggle = await screen.findByRole("checkbox", { name: "Объём" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("checkbox", { name: "Содержит подсластитель" })).toBeNull();
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Подтвердить категорию" }));
  await waitFor(() => expect(writes[1]?.body).toEqual({ acceptedEntryIds: [] }));
  expect(writes[0]?.url).toBe(`/api/products/${PRODUCT_ID}/category-change-previews`);
});
it("saves a validated EGAIS collection and primary code for applicable bound products", async () => {
  const { user, writes } = mount({ group: 15 });
  await user.click(await screen.findByRole("button", { name: "Добавить код АП ЕГАИС" }));
  await user.type(screen.getByLabelText("Код АП ЕГАИС 1"), "1234567890123456789");
  await user.click(screen.getByRole("button", { name: "Сохранить коды ЕГАИС" }));
  expect(writes).toEqual([]);
  expect(await screen.findByText(/Каждый код должен содержать 19 цифр/)).toBeDefined();
  await user.selectOptions(screen.getByLabelText("Основной код АП ЕГАИС"), "1234567890123456789");
  await user.click(screen.getByRole("button", { name: "Сохранить коды ЕГАИС" }));
  await waitFor(() =>
    expect(writes[0]).toEqual({
      url: `/api/products/${PRODUCT_ID}/egais-codes`,
      body: { baseRevision: 4, codes: ["1234567890123456789"], primaryCode: "1234567890123456789" },
    }),
  );
});

it.each(["attributes", "category", "egais"] as const)(
  "preserves the dirty %s editor and its close guard when a background read fails",
  async (kind) => {
    const { user, client, failProfileRead, onDirtyChange } = mount({
      group: kind === "egais" ? 15 : 23,
    });
    if (kind === "attributes") {
      await user.clear(await screen.findByLabelText("Объём"));
      await user.type(screen.getByLabelText("Объём"), "875");
    }
    if (kind === "category") {
      await user.click(await screen.findByRole("button", { name: "Сменить категорию" }));
      await user.type(screen.getByLabelText("ОКПД2"), "10.32");
    }
    if (kind === "egais") {
      await user.click(await screen.findByRole("button", { name: "Добавить код АП ЕГАИС" }));
      await user.type(screen.getByLabelText("Код АП ЕГАИС 1"), "1234567890123456789");
    }
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    failProfileRead();
    await client.invalidateQueries({ queryKey: ["products", PRODUCT_ID, "regulatory-profile"] });
    expect(await screen.findByText("Не удалось загрузить характеристики категории.")).toBeDefined();
    expect(
      screen.getByLabelText(
        kind === "attributes" ? "Объём" : kind === "category" ? "ОКПД2" : "Код АП ЕГАИС 1",
      ),
    ).toHaveProperty(
      "value",
      kind === "attributes" ? "875" : kind === "category" ? "10.32" : "1234567890123456789",
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  },
);

it("reloads the actual server revision after a 409 without rebasing unsaved input automatically", async () => {
  const { user, writes } = mount({ conflictOnce: true });
  const field = await screen.findByLabelText("Объём");
  await user.clear(field);
  await user.type(field, "800");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await screen.findByText(/Карточка изменилась/);
  expect(screen.getByLabelText("Объём")).toHaveProperty("value", "800");
  await user.click(
    screen.getByRole("button", { name: "Отменить правки и загрузить актуальные данные" }),
  );
  await waitFor(() => expect(screen.getByLabelText("Объём")).toHaveProperty("value", "500"));
  await user.clear(screen.getByLabelText("Объём"));
  await user.type(screen.getByLabelText("Объём"), "700");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() => expect(writes[1]?.body).toMatchObject({ baseRevision: 9 }));
});
it("accepts a free enum value when the schema has no preset constraint", async () => {
  const pinned = profileSchema.parse(profile());
  if (!pinned.definition) throw Error("Fixture schema missing");
  pinned.definition.attributes.push({
    id: "free",
    label: "Назначение",
    valueType: "enum",
    multiplicity: "one",
    unit: null,
    requirementRules: [],
    presetMode: "none",
    presets: [],
  });
  const { user, writes } = mount({ customProfile: pinned });
  await user.type(await screen.findByLabelText("Назначение"), "Уход за кожей");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() =>
    expect(writes[0]?.body).toEqual({
      baseRevision: 4,
      values: [{ attributeId: "free", value: { type: "enum", value: "Уход за кожей" } }],
    }),
  );
});

it("keeps accepted classification when opening the category editor cannot refresh the profile", async () => {
  const { user, failProfileRead } = mount();
  await screen.findByRole("button", { name: "Сменить категорию" });
  failProfileRead();
  await user.click(screen.getByRole("button", { name: "Сменить категорию" }));
  await screen.findByText(
    "Не удалось загрузить актуальную карточку. Правки остались в форме; повторите попытку.",
  );
  expect(screen.getByLabelText("ТН ВЭД")).toHaveProperty("value", "2009719909");
});
