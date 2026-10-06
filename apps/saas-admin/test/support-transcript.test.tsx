import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { SupportTranscript } from "../src/pages/support/SupportTranscript.js";
import { jsonResponse } from "./render.js";
import type * as PlatformAuth from "../src/auth/PlatformAuthBoundary.js";

vi.mock("../src/auth/PlatformAuthBoundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformAuth>();
  const { platformCapabilitiesForRole } = await import("@markiro/platform-contracts");
  return {
    ...actual,
    usePlatformPrincipal: () => ({
      userId: "operator-a",
      role: "accountant",
      capabilities: [...platformCapabilitiesForRole.accountant],
      twoFactorReady: true,
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows only the public transcript page and sync lag in the request workspace", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const second = String(input).includes("cursor=more");
      return jsonResponse(200, {
        items: [
          {
            id: second
              ? "00000000-0000-4000-8000-000000000902"
              : "00000000-0000-4000-8000-000000000901",
            direction: second ? "operator" : "customer",
            text: second ? "Публичный ответ" : "Вопрос клиента",
            occurredAt: "2026-10-06T10:00:00.000Z",
            delivery: "sent",
          },
          ...(second
            ? [
                {
                  id: "00000000-0000-4000-8000-000000000901",
                  direction: "customer",
                  text: "Вопрос клиента",
                  occurredAt: "2026-10-06T10:00:00.000Z",
                  delivery: "sent",
                },
              ]
            : []),
        ],
        nextCursor: second ? null : "more",
        sync: { state: "pending", lastSyncedAt: null, errorCode: null },
      });
    }),
  );
  render(
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SupportTranscript requestId="00000000-0000-4000-8000-000000000903" />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  expect(await screen.findByText("Вопрос клиента")).toBeTruthy();
  expect(screen.getByText("История синхронизируется")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Ранние сообщения" }));
  await waitFor(() => expect(screen.getByText("Публичный ответ")).toBeTruthy());
  expect(screen.getByText("Вопрос клиента")).toBeTruthy();
  expect(screen.getAllByText("Вопрос клиента")).toHaveLength(1);
});
