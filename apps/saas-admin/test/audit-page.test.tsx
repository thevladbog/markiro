import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, PLATFORM_ADMIN_ME, renderSaasApp, TENANT_ID } from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("platform audit page", () => {
  it("presents audit events as a named operational register", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.includes("/api/platform/audit?")) {
          return jsonResponse(200, {
            items: [
              {
                id: "81111111-1111-4111-8111-111111111111",
                actorPlatformUserId: "platform-admin",
                actorRole: "platform_admin",
                action: "tenant.created",
                outcome: "success",
                tenantId: TENANT_ID,
                targetType: "tenant",
                targetId: TENANT_ID,
                reason: null,
                before: null,
                after: { name: "Первый завод" },
                requestId: null,
                createdAt: "2026-08-21T10:00:00.000Z",
              },
            ],
            nextOffset: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp({ initialEntry: "/audit" });

    expect(await screen.findByRole("heading", { name: "Аудит платформы" })).toBeDefined();
    expect(screen.getByText("Неизменяемая история действий и результатов.")).toBeDefined();
    expect(await screen.findByText("Неизменяемый журнал событий")).toBeDefined();
    expect(await screen.findByRole("region", { name: "Журнал аудита" })).toBeDefined();
    expect(screen.getByText("tenant.created")).toBeDefined();
  });
});
