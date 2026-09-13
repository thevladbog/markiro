import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { ValidationReprocessingHistory } from "../src/pages/shifts/ValidationReprocessingHistory.js";
const shiftId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const row = {
  codeHash: "a".repeat(64),
  canonicalRaw: "01FULL\u001d92CRYPTO/+==",
  sourceShift: { id: sourceId, number: "SEP26-002", productName: "Молоко", date: null },
  occurrence: {
    shiftId,
    deviceId: sourceId,
    operatorId: null,
    scannedAt: "2026-09-12T10:00:00.000Z",
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ValidationReprocessingHistory shiftId={id} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(view(shiftId)), view };
}
it("scopes pages to the current shift and does not leak a late previous response", async () => {
  await i18n.changeLanguage("ru");
  let resolveOld: ((value: Response) => void) | undefined;
  const request = vi.fn((url: string) => {
    if (url.includes(shiftId) && url.includes("cursor="))
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    return Promise.resolve(
      json({
        items: url.includes(shiftId) ? [row] : [],
        nextCursor: url.includes(shiftId) ? row.codeHash : null,
      }),
    );
  });
  vi.stubGlobal("fetch", request);
  const rendered = setup();
  await screen.findByRole("link", { name: "SEP26-002" });
  fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
  await waitFor(() => expect(resolveOld).toBeDefined());
  expect(request.mock.calls[1]?.[0]).toBe(
    `/api/shifts/${shiftId}/reprocessings?limit=50&cursor=${row.codeHash}`,
  );
  rendered.rerender(rendered.view(sourceId));
  await screen.findByText("Повторных обработок пока нет");
  await act(async () => {
    resolveOld?.(
      json({
        items: [{ ...row, codeHash: "b".repeat(64), canonicalRaw: "LATE OLD CODE" }],
        nextCursor: null,
      }),
    );
  });
  expect(screen.queryByText("LATE OLD CODE")).toBeNull();
  expect(screen.queryByRole("link", { name: "SEP26-002" })).toBeNull();
});
it("keeps exact raw bytes on pagination and shows safe missing-data labels", async () => {
  await i18n.changeLanguage("ru");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        json({
          items: [
            url.includes("cursor=")
              ? {
                  ...row,
                  codeHash: "b".repeat(64),
                  canonicalRaw: "",
                  sourceShift: { ...row.sourceShift, number: "", productName: "" },
                }
              : row,
          ],
          nextCursor: url.includes("cursor=") ? null : row.codeHash,
        }),
      ),
    ),
  );
  setup();
  await screen.findByRole("link", { name: "SEP26-002" });
  expect(
    screen.getByText((_, el) => el?.tagName === "CODE" && el.textContent === row.canonicalRaw)
      .textContent,
  ).toBe(row.canonicalRaw);
  fireEvent.click(screen.getByRole("button", { name: "Загрузить ещё" }));
  await screen.findByText("Полный код недоступен");
  expect(screen.getByText(/Исходная смена не указана/)).toBeTruthy();
  expect(screen.getByText("Товар не указан")).toBeTruthy();
  expect(screen.queryByText(sourceId)).toBeNull();
  expect(screen.queryByText("b".repeat(64))).toBeNull();
});
it("distinguishes loading from empty and allows retry after a read error", async () => {
  await i18n.changeLanguage("ru");
  let resolve: ((value: Response) => void) | undefined;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", request);
  setup();
  expect(screen.queryByText("Повторных обработок пока нет")).toBeNull();
  await act(async () => {
    resolve?.(json({}, 503));
  });
  await screen.findByText("Не удалось загрузить повторные обработки");
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await screen.findByText("Повторных обработок пока нет");
});
