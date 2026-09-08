import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { ProductLabelHistory } from "../src/pages/shifts/ProductLabelHistory.js";
const shiftId = "11111111-1111-4111-8111-111111111111",
  jobId = "22222222-2222-4222-8222-222222222222",
  deviceId = "33333333-3333-4333-8333-333333333333",
  operatorId = "44444444-4444-4444-8444-444444444444";
const summary = { sentAttempts: 2, verifiedAttempts: 1, unresolvedJobs: 0, reprintAttempts: 1 };
const row = {
  jobId,
  deviceId,
  codeSuffix: "IAL-42",
  acceptedAt: "2026-09-08T10:00:00.000Z",
  status: "completed",
  verificationOutcome: "verified",
  attemptNo: 2,
  ownershipConflict: false,
};
const event = {
  eventId: "55555555-5555-4555-8555-555555555555",
  jobId,
  attemptId: "66666666-6666-4666-8666-666666666666",
  sequence: 4,
  shiftId,
  codeHash: "a".repeat(64),
  acceptedAt: row.acceptedAt,
  policyRevision: "77777777-7777-4777-8777-777777777777",
  templateDigest: "b".repeat(64),
  payloadDigest: "c".repeat(64),
  operatorId,
  occurredAt: row.acceptedAt,
  kind: "prepared",
  attemptNo: 2,
  reason: "damaged",
  language: "zpl",
  dpi: 203,
  bytesDigest: "d".repeat(64),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function renderHistory() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProductLabelHistory shiftId={shiftId} />
    </QueryClientProvider>,
  );
}
describe("cabinet label history", () => {
  it("shows separate totals, safe identity, operator and reason without print actions", async () => {
    await i18n.changeLanguage("ru");
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes("/events")
              ? { items: [event], nextSequence: null }
              : url.includes("/operators")
                ? {
                    items: [
                      {
                        employeeId: operatorId,
                        fullName: "Мария",
                        role: null,
                        login: "00001",
                        active: true,
                        hasBadge: false,
                      },
                    ],
                  }
                : { summary, items: [row], nextCursor: null },
          ),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("…IAL-42");
    expect(screen.getByText("Отправки на принтер").parentElement?.textContent).toContain("2");
    fireEvent.click(screen.getByRole("button", { name: "История попыток · …IAL-42" }));
    await screen.findByText("Мария");
    await screen.findByText("Этикетка повреждена");
    expect(fetch.mock.calls.some(([url]) => url.includes(`deviceId=${deviceId}`))).toBe(true);
    expect(screen.queryByRole("button", { name: /Печатать|Напечатать/ })).toBeNull();
  });
  it("loads the next page and keeps sent distinct from verified", async () => {
    await i18n.changeLanguage("ru");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              summary,
              items: [
                url.includes("cursor=")
                  ? {
                      ...row,
                      jobId: "88888888-8888-4888-8888-888888888888",
                      codeSuffix: "IAL-43",
                      verificationOutcome: "not_required",
                    }
                  : row,
              ],
              nextCursor: url.includes("cursor=") ? null : "page-2",
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    renderHistory();
    await screen.findByText("…IAL-42");
    fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
    await screen.findByText("…IAL-43");
    await screen.findByText("Отправлено на принтер");
  });
  it("shows a recoverable read error instead of inventing zero totals", async () => {
    await i18n.changeLanguage("ru");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ summary, items: [], nextCursor: null }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    renderHistory();
    await screen.findByText("Не удалось загрузить историю печати");
    expect(screen.queryByText("Отправки на принтер")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(screen.queryByText("Не удалось загрузить историю печати")).toBeNull(),
    );
    await screen.findByText("Этикеток пока нет");
  });
});
