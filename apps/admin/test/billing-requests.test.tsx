import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { CreateRequestPage } from "../src/pages/billing/CreateRequestPage.js";
import { RequestDetailPage } from "../src/pages/billing/RequestDetailPage.js";
import { RequestsPage } from "../src/pages/billing/RequestsPage.js";
import { validCivilDate, validateBillingRequestForm } from "../src/pages/billing/requestForm.js";
import { invalidateTenantBillingRequests } from "../src/pages/billing/api.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000501";
const KEY = "00000000-0000-4000-8000-000000000599";

const request = {
  id: REQUEST_ID,
  number: "BR-000042",
  type: "capacity_change",
  status: "new",
  description: "Добавить две линии",
  desiredAt: "2026-09-10T00:00:00.000Z",
  context: { type: "limit", id: "lines" },
  responsibleSide: "markiro",
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T08:00:00.000Z",
  events: [],
  attachments: [],
  links: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderBilling(element: React.ReactNode, initialEntry = "/billing/requests") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <AccessProvider
          value={{
            roles: ["owner"],
            capabilities: [CABINET_CAPABILITY.BILLING_READ, CABINET_CAPABILITY.BILLING_REQUEST],
          }}
        >
          <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
              <Route path="/billing/requests" element={element} />
              <Route path="/billing/requests/new" element={element} />
              <Route path="/billing/requests/:id" element={<RequestDetailPage />} />
            </Routes>
          </MemoryRouter>
        </AccessProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("renders loading, error, empty, and exact status/type filter requests with clearing", async () => {
  let resolveFirst!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
    .mockResolvedValueOnce(json({ items: [] }))
    .mockResolvedValueOnce(json({ items: [] }))
    .mockResolvedValueOnce(json({ items: [] }))
    .mockResolvedValueOnce(json({ items: [] }));
  vi.stubGlobal("fetch", fetch);
  renderBilling(<RequestsPage />);
  expect(screen.getByText("Загрузка заявок")).toBeDefined();
  resolveFirst(json({ code: "failed" }, 503));
  expect(await screen.findByText("Не удалось загрузить заявки")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Заявок по выбранным фильтрам нет")).toBeDefined();

  fireEvent.change(screen.getByLabelText("Статус заявки"), {
    target: { value: "under_review" },
  });
  await waitFor(() =>
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/billing/requests?status=under_review",
      expect.any(Object),
    ),
  );
  fireEvent.change(screen.getByLabelText("Тип заявки"), { target: { value: "renewal" } });
  await waitFor(() =>
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/billing/requests?status=under_review&type=renewal",
      expect.any(Object),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Очистить фильтры" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenLastCalledWith("/api/billing/requests", expect.any(Object)),
  );
});

it("shows all five server request types and validates description, desired date, and files", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  const type = screen.getByLabelText("Тип заявки");
  expect(
    within(type)
      .getAllByRole("option")
      .map((option) => option.getAttribute("value")),
  ).toEqual(["renewal", "capacity_change", "additional_service", "documents", "other"]);

  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(screen.getByText("Опишите запрос: от 1 до 4000 символов.")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "x".repeat(4001) } });
  fireEvent.change(screen.getByLabelText("Вложения"), {
    target: {
      files: [
        new File(["plain"], "notes.txt", { type: "text/plain" }),
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.pdf", {
          type: "application/pdf",
        }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(screen.getByText("Описание не должно превышать 4000 символов.")).toBeDefined();
  expect(validCivilDate("2026-02-30")).toBe(false);
  expect(screen.getByText("notes.txt: разрешены PDF, JPEG и PNG.")).toBeDefined();
  expect(screen.getByText("large.pdf: размер не должен превышать 5 МиБ.")).toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(
    validateBillingRequestForm({
      type: "other",
      description: "Files",
      desiredAt: "",
      contextType: "",
      contextId: "",
      files: [
        new File(["pdf"], "a.pdf", { type: "application/pdf" }),
        new File(["jpg"], "a.jpg", { type: "image/jpeg" }),
        new File(["png"], "a.png", { type: "image/png" }),
      ],
    }).files,
  ).toEqual([]);
});

it("does not offer an ambiguous retry for a terminal create rejection", async () => {
  const uuid = vi
    .fn()
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000591")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000592");
  vi.stubGlobal("crypto", { randomUUID: uuid });
  const fetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(json({ code: "validation_failed" }, 400))
    .mockResolvedValueOnce(json(request));
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Продлить" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(
    await screen.findByText("Сервер отклонил заявку. Проверьте данные и отправьте снова."),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
  expect(screen.getByLabelText("Описание")).toHaveProperty("value", "Продлить");
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  await screen.findByRole("heading", { name: "Заявка BR-000042" });
  const keys = fetch.mock.calls
    .filter((call) => call[1]?.method === "POST")
    .map((call) => JSON.parse(String(call[1]?.body)).idempotencyKey);
  expect(keys).toEqual([
    "00000000-0000-4000-8000-000000000591",
    "00000000-0000-4000-8000-000000000592",
  ]);
});

it("invalidates only the request family and overview after a request mutation", async () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  await invalidateTenantBillingRequests(client, REQUEST_ID);
  expect(invalidate.mock.calls).toEqual([
    [{ queryKey: ["tenant-billing", "requests"] }],
    [{ queryKey: ["tenant-billing", "overview"] }],
  ]);
});

it("prefills valid limit context and never sends an invalid URL context", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(request));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
  renderBilling(
    <CreateRequestPage />,
    "/billing/requests/new?type=capacity_change&contextType=limit&contextId=lines",
  );
  expect(screen.getByLabelText("Тип заявки")).toHaveProperty("value", "capacity_change");
  expect(screen.getByText("Контекст: Лимит — Линии")).toBeDefined();
  cleanup();
  fetch.mockClear();
  renderBilling(
    <CreateRequestPage />,
    "/billing/requests/new?type=capacity_change&contextType=limit&contextId=../../secret",
  );
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "  Две линии  " } });
  fireEvent.change(screen.getByLabelText("Желаемая дата"), {
    target: { value: "2026-09-10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    type: "capacity_change",
    description: "Две линии",
    desiredAt: "2026-09-10T00:00:00.000Z",
    idempotencyKey: KEY,
  });
});

it("retains one immutable JSON payload and key across an ambiguous retry and locks double clicks", async () => {
  const uuid = vi.fn(() => KEY);
  vi.stubGlobal("crypto", { randomUUID: uuid });
  let reject!: (reason: unknown) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce(json(request));
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "  Продлить  " } });
  const submit = screen.getByRole("button", { name: "Создать заявку" });
  submit.click();
  submit.click();
  expect(fetch).toHaveBeenCalledTimes(1);
  reject(new Error("offline"));
  const retry = await screen.findByRole("button", { name: "Повторить отправку" });
  retry.click();
  await screen.findByRole("heading", { name: "Заявка BR-000042" });
  const bodies = fetch.mock.calls
    .filter((call) => call[1]?.method === "POST")
    .map((call) => String(call[1]?.body));
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
    type: "renewal",
    description: "Продлить",
    idempotencyKey: KEY,
  });
  expect(uuid).toHaveBeenCalledTimes(1);
});

it("creates once, uploads sequentially, navigates after settlement, and retries only failed files", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
  let firstUploadDone = false;
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/billing/requests") && init?.method === "POST") return json(request);
    if (url.endsWith(`/api/billing/requests/${REQUEST_ID}/attachments`)) {
      const name = (init?.body as FormData).get("file") as File;
      if (name.name === "first.pdf") {
        firstUploadDone = true;
        return json({ id: "a1", fileName: name.name, contentType: name.type, byteSize: name.size });
      }
      expect(firstUploadDone).toBe(true);
      if (calls.filter((item) => item.endsWith("/attachments")).length === 2) {
        return json({ code: "storage_unavailable" }, 503);
      }
      return json({ id: "a2", fileName: name.name, contentType: name.type, byteSize: name.size });
    }
    if (url.endsWith(`/api/billing/requests/${REQUEST_ID}`)) return json(request);
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Документы" } });
  fireEvent.change(screen.getByLabelText("Вложения"), {
    target: {
      files: [
        new File(["%PDF-1"], "first.pdf", { type: "application/pdf" }),
        new File(["%PDF-2"], "second.pdf", { type: "application/pdf" }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(await screen.findByRole("heading", { name: "Заявка BR-000042" })).toBeDefined();
  expect(screen.getByText("first.pdf: загружен")).toBeDefined();
  expect(screen.getByText("second.pdf: не загружен")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку second.pdf" }));
  expect(await screen.findByText("second.pdf: загружен")).toBeDefined();
  expect(
    calls.filter((url) => url.endsWith("/api/billing/requests") && !url.includes(REQUEST_ID)),
  ).toHaveLength(1);
});

it("renders the request registry in Russian and English", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ items: [request] })),
  );
  renderBilling(<RequestsPage />);
  expect(await screen.findByRole("heading", { name: "Заявки" })).toBeDefined();
  expect(
    within(screen.getByRole("table")).getByText("Изменение лимитов или мощности"),
  ).toBeDefined();
  await i18n.changeLanguage("en");
  expect(screen.getByRole("heading", { name: "Requests" })).toBeDefined();
  expect(within(screen.getByRole("table")).getByText("Limits or capacity change")).toBeDefined();
});
