import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { jsonResponse, PLATFORM_ADMIN_ME, renderSaasApp } from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("refreshes, reviews, and activates a discovered National Catalog category", async () => {
  const schemaVersionId = "00000000-0000-4000-8000-000000000001";
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      if (url.endsWith("/api/platform/operations/national-catalog/schemas")) {
        return jsonResponse(200, {
          configured: true,
          sourceTenantId: "tenant-1",
          versions: [
            {
              id: schemaVersionId,
              categoryId: "245615018",
              categoryName: "Сидр",
              status: "observed",
              fetchedAt: "2026-09-14T10:00:00.000Z",
              activatedAt: null,
              blockedReasons: [],
              mappings: [
                {
                  chzProductGroupCode: 7,
                  chzProductGroupName:
                    "Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки",
                  state: "ambiguous",
                  reviewedAt: null,
                },
              ],
            },
          ],
        });
      }
      if (url.endsWith("/national-catalog/schema-refresh")) {
        return jsonResponse(200, {
          categories: 1,
          observed: 0,
          unchanged: 1,
          blocked: 0,
          failed: 0,
        });
      }
      if (url.endsWith("/national-catalog/group-mappings/7/review")) {
        return jsonResponse(200, {
          chzProductGroupCode: 7,
          state: "exact",
          schemaVersionIds: [schemaVersionId],
          reviewedAt: "2026-09-14T10:05:00.000Z",
        });
      }
      if (url.endsWith(`/national-catalog/schema-versions/${schemaVersionId}/activate`)) {
        return jsonResponse(200, {
          schemaVersionId,
          priorSchemaVersionId: null,
          alreadyActive: false,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );

  renderSaasApp({ initialEntry: "/national-catalog" });
  const user = userEvent.setup();
  expect(await screen.findByRole("heading", { name: "Национальный каталог" })).toBeDefined();
  expect(await screen.findByText("Сидр")).toBeDefined();
  expect(screen.getByText("245615018")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Обновить категории" }));
  await user.click(screen.getByRole("button", { name: "Подтвердить сопоставление" }));
  await user.click(screen.getByRole("button", { name: "Активировать категорию" }));

  await waitFor(() => {
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          body: { sourceTenantId: "tenant-1" },
          url: expect.stringMatching(/\/national-catalog\/schema-refresh$/u),
        }),
        expect.objectContaining({
          method: "POST",
          body: { state: "exact", schemaVersionIds: [schemaVersionId] },
          url: expect.stringMatching(/\/national-catalog\/group-mappings\/7\/review$/u),
        }),
        expect.objectContaining({
          method: "POST",
          url: expect.stringMatching(
            new RegExp(`/national-catalog/schema-versions/${schemaVersionId}/activate$`, "u"),
          ),
        }),
      ]),
    );
  });
});
