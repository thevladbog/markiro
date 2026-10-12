import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrgProfilePage } from "../src/pages/settings/OrgProfilePage.js";
import { MemoryRouter } from "react-router";
import type { OrgProfileDto } from "../src/pages/settings/api.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "shows catalog categories and preserves saved unused overrides (%s)",
  async (savedUnused) => {
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
      categoryPalletSheetTemplateDefaults: savedUnused
        ? [{ chzProductGroupCode: 8, templateId: "sheet" }]
        : [],
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
            url.endsWith("profile/sscc")
              ? { counters: [] }
              : url.endsWith("org/profile") && init?.method !== "PUT"
                ? profile
                : url.endsWith("chz-product-groups")
                  ? {
                      items: [
                        { code: 15, name: "Пиво", alias: "beer" },
                        { code: 8, name: "Вода", alias: "water" },
                        { code: 16, name: "Табак", alias: "tobacco" },
                      ],
                    }
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
        <MemoryRouter>
          <OrgProfilePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const select = await screen.findByRole("combobox", { name: "Шаблон А4 для организации" });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url.endsWith("label-templates"))).toBe(true),
    );
    await screen.findByRole("combobox", { name: "А4 для категории Пиво" });
    expect(screen.queryByRole("combobox", { name: "А4 для категории Табак" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "А4 для категории Вода" }) !== null).toBe(
      savedUnused,
    );
    fireEvent.pointerDown(select, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(await screen.findByRole("option", { name: "My A4" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Legacy" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "My A4" }));
    expect(screen.queryByRole("button", { name: "Сохранить настройки А4" })).toBeNull();
    const form = select.closest("form");
    if (!form) throw new Error("A4 selection must share the profile form");
    fireEvent.click(within(form).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1),
    );
    const payload = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.body),
    );
    expect(payload).toMatchObject({
      defaultPalletSheetTemplateId: "sheet",
    });
    expect(payload).not.toHaveProperty("defaultPalletLabelTemplateId");
  },
);
