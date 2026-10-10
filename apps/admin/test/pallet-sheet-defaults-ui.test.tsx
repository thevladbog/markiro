import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PalletSheetDefaults } from "../src/pages/settings/PalletSheetDefaults.js";
import type { OrgProfileDto } from "../src/pages/settings/api.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("assigns only sheet defaults and confirms saving without touching the V1 default", async () => {
  const profile: OrgProfileDto = {
    gln: null,
    gs1Prefixes: [],
    inn: null,
    timeZone: "Europe/Moscow",
    defaultBoxLabelTemplateId: null,
    categoryBoxLabelTemplateDefaults: [],
    defaultPalletLabelTemplateId: "legacy",
    categoryPalletLabelTemplateDefaults: [],
    productGroupsInUse: [15],
    pickupLimitsEnabled: false,
    logoUrl: null,
    logoRevision: null,
  };
  const sheet = {
    id: "sheet",
    name: "My A4",
    purpose: "pallet",
    format: "pallet_sheet_v2",
    revision: 1,
    page: { size: "A4", orientation: "portrait", copies: 1 },
    dpi: 300,
    enabled: true,
    chzProductGroupCodes: null,
  };
  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          url.endsWith("chz-product-groups")
            ? { items: [{ code: 15, name: "Пиво", alias: "beer" }] }
            : init?.method === "PUT"
              ? { ...profile, ...JSON.parse(String(init.body)) }
              : {
                  items: [
                    sheet,
                    {
                      ...sheet,
                      id: "legacy",
                      name: "Legacy",
                      format: "label_v1",
                      widthMm: 100,
                      heightMm: 150,
                      language: "zpl",
                    },
                  ],
                },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PalletSheetDefaults profile={profile} />
    </QueryClientProvider>,
  );
  const select = await screen.findByRole("combobox", { name: "Шаблон А4 для организации" });
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("label-templates"))).toBe(true),
  );
  fireEvent.pointerDown(select, { button: 0, ctrlKey: false, pointerId: 1, pointerType: "mouse" });
  expect(await screen.findByRole("option", { name: "My A4" })).toBeDefined();
  expect(screen.queryByRole("option", { name: "Legacy" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "My A4" }));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки А4" }));
  await screen.findByText("Настройки А4 сохранены");
  const payload = JSON.parse(
    String(fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body),
  );
  expect(payload).toEqual({
    defaultPalletSheetTemplateId: "sheet",
    categoryPalletSheetTemplateDefaults: [],
  });
  expect(payload).not.toHaveProperty("defaultPalletLabelTemplateId");
});
