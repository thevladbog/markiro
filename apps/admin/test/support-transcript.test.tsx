import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { SupportTranscript } from "../src/pages/support/SupportTranscript.js";

const requestId = "00000000-0000-4000-8000-000000000801";
const longText = "А".repeat(4_500);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads a paged public transcript with author, time and full long text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const second = url.includes("cursor=older");
      return new Response(
        JSON.stringify({
          items: [
            {
              id: second
                ? "00000000-0000-4000-8000-000000000803"
                : "00000000-0000-4000-8000-000000000802",
              direction: second ? "operator" : "customer",
              text: second ? "Ответ оператора" : longText,
              occurredAt: "2026-10-06T10:00:00.000Z",
              delivery: "sent",
            },
            ...(second
              ? [
                  {
                    id: "00000000-0000-4000-8000-000000000802",
                    direction: "customer",
                    text: longText,
                    occurredAt: "2026-10-06T10:00:00.000Z",
                    delivery: "sent",
                  },
                ]
              : []),
          ],
          nextCursor: second ? null : "older",
          sync: { state: "pending", lastSyncedAt: null, errorCode: null },
        }),
        { status: 200 },
      );
    }),
  );
  render(
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SupportTranscript requestId={requestId} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  expect(await screen.findByText(longText)).toBeTruthy();
  expect(screen.getByText("Вы")).toBeTruthy();
  expect(screen.getByText(/История обращения синхронизируется/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Показать ранние сообщения" }));
  await waitFor(() => expect(screen.getByText("Ответ оператора")).toBeTruthy());
  expect(screen.getByText(longText)).toBeTruthy();
  expect(screen.getAllByText(longText)).toHaveLength(1);
});
