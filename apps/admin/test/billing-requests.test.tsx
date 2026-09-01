import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import { ApiRequestError } from "../src/api/client.js";
import i18n from "../src/i18n/index.js";
import { CreateRequestPage } from "../src/pages/billing/CreateRequestPage.js";
import { RequestDetailPage } from "../src/pages/billing/RequestDetailPage.js";
import { RequestsPage } from "../src/pages/billing/RequestsPage.js";
import { validCivilDate, validateBillingRequestForm } from "../src/pages/billing/requestForm.js";
import {
  invalidateTenantBillingRequests,
  type TenantBillingRequestAttachment,
  type TenantBillingRequestDetail,
} from "../src/pages/billing/api.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000501";
const KEY = "00000000-0000-4000-8000-000000000599";

const request: TenantBillingRequestDetail = {
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

const firstAttachment: TenantBillingRequestAttachment = {
  id: "00000000-0000-4000-8000-000000000611",
  fileName: "first.pdf",
  contentType: "application/pdf",
  byteSize: 6,
  sha256: "first-sha256",
  createdAt: "2026-08-28T08:10:00.000Z",
};

const secondAttachment: TenantBillingRequestAttachment = {
  id: "00000000-0000-4000-8000-000000000612",
  fileName: "second.pdf",
  contentType: "application/pdf",
  byteSize: 6,
  sha256: "second-sha256",
  createdAt: "2026-08-28T08:11:00.000Z",
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
  vi.useRealTimers();
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

it.each([
  { failure: json({ code: "forbidden" }, 403), message: "Нет доступа к заявкам" },
  { failure: json({ code: "not_found" }, 404), message: "Реестр заявок не найден" },
])("renders $message without a dead list retry", async ({ failure, message }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => failure),
  );
  renderBilling(<RequestsPage />);
  expect(await screen.findByText(message)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
});

it.each([new Error("offline"), new ApiRequestError(503, "unavailable", "unavailable")])(
  "keeps list retry available for an ambiguous failure",
  async (failure) => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(json({ items: [] }));
    vi.stubGlobal("fetch", fetch);
    renderBilling(<RequestsPage />);
    expect(await screen.findByText("Не удалось загрузить заявки")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Заявок по выбранным фильтрам нет")).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

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
  fireEvent.change(screen.getByTestId("file-drop-input"), {
    target: {
      files: [
        new File(["zip"], "archive.zip", { type: "application/zip" }),
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.pdf", {
          type: "application/pdf",
        }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(screen.getByText("Описание не должно превышать 4000 символов.")).toBeDefined();
  expect(validCivilDate("2026-02-30")).toBe(false);
  expect(screen.getByText("archive.zip: разрешены PDF, JPEG, PNG и TXT.")).toBeDefined();
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
        new File(["plain"], "a.txt", { type: "text/plain" }),
      ],
    }).files,
  ).toEqual([]);
  expect(screen.getByTestId("file-drop-input").getAttribute("accept")).toBe(
    "application/pdf,image/jpeg,image/png,text/plain",
  );
});

it("uses the shared branded calendar and multiple-file drop zone for a new request", () => {
  vi.stubGlobal("fetch", vi.fn());
  renderBilling(<CreateRequestPage />, "/billing/requests/new");

  expect(screen.getByRole("button", { name: "Желаемая дата" })).toBeDefined();
  const dropZone = screen.getByRole("button", { name: "Вложения" });
  const fileInput = screen.getByTestId("file-drop-input") as HTMLInputElement;
  expect(fileInput.multiple).toBe(true);

  const first = new File(["%PDF-1"], "contract.pdf", { type: "application/pdf" });
  const second = new File(["details"], "details.txt", { type: "text/plain" });
  fireEvent.drop(dropZone, { dataTransfer: { files: [first, second] } });

  expect(screen.getByText("contract.pdf")).toBeDefined();
  expect(screen.getByText("details.txt")).toBeDefined();
});

it.each([
  {
    failure: json({ code: "validation_failed" }, 400),
    message: "Сервер отклонил данные заявки. Проверьте поля и отправьте снова.",
  },
  {
    failure: json({ code: "idempotency_key_reused" }, 409),
    message: "Ключ отправки уже использован для другой заявки. Отправьте форму заново.",
  },
])("classifies a terminal create response as $message", async ({ failure, message }) => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => failure),
  );
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Продлить" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(await screen.findByText(message)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
});

it("enters the established forbidden state after create 403 and blocks stale form submissions", async () => {
  const uuid = vi
    .fn()
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000591")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000592");
  vi.stubGlobal("crypto", { randomUUID: uuid });
  const fetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(json({ code: "forbidden" }, 403))
    .mockResolvedValueOnce(json(request));
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Продлить" } });
  const submit = screen.getByRole("button", { name: "Создать заявку" });
  const form = submit.closest("form");
  if (!form) throw new Error("create request form fixture is missing");
  fireEvent.click(submit);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.getByText("Эта страница недоступна")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Создать заявку" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
  fireEvent.click(submit);
  fireEvent.submit(form);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(uuid).toHaveBeenCalledTimes(1);
});

it.each([new Error("offline"), new ApiRequestError(503, "unavailable", "unavailable")])(
  "retains a live create retry only for an ambiguous response",
  async (failure) => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
    const fetch = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(json(request));
    vi.stubGlobal("fetch", fetch);
    renderBilling(<CreateRequestPage />, "/billing/requests/new");
    fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Продлить" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторить отправку" }));
    expect(await screen.findByRole("heading", { name: "Заявка BR-000042" })).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

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
    await screen.findByText("Сервер отклонил данные заявки. Проверьте поля и отправьте снова."),
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
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
  fireEvent.click(screen.getByRole("button", { name: "Желаемая дата" }));
  fireEvent.click(screen.getByRole("button", { name: "Следующий месяц" }));
  fireEvent.click(screen.getByRole("button", { name: "10 сентября 2026" }));
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

it("merges complete upload rows, locks retry double clicks, and reconciles an active refetch", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
  let firstUploadDone = false;
  let secondUploadCount = 0;
  let resolveRetry!: (response: Response) => void;
  const calls: Array<{
    url: string;
    method: string;
    idempotencyKey: FormDataEntryValue | null | undefined;
  }> = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      idempotencyKey: init?.body instanceof FormData ? init.body.get("idempotencyKey") : undefined,
    });
    if (url.endsWith("/api/billing/requests") && method === "POST") {
      return Promise.resolve(json(request));
    }
    if (url.endsWith(`/api/billing/requests/${REQUEST_ID}/attachments`)) {
      const name = (init?.body as FormData).get("file") as File;
      if (name.name === "first.pdf") {
        firstUploadDone = true;
        return Promise.resolve(json(firstAttachment));
      }
      expect(firstUploadDone).toBe(true);
      secondUploadCount += 1;
      if (secondUploadCount === 1) {
        return Promise.resolve(json({ code: "storage_unavailable" }, 503));
      }
      return new Promise<Response>((resolve) => {
        resolveRetry = resolve;
      });
    }
    if (url.endsWith(`/api/billing/requests/${REQUEST_ID}`)) {
      return Promise.resolve(
        json({ ...request, attachments: [firstAttachment, secondAttachment] }),
      );
    }
    if (url.endsWith(`/attachments/${secondAttachment.id}/download`)) {
      return Promise.resolve(json({ url: "https://signed.example/second.pdf" }));
    }
    return Promise.reject(new Error(`Unexpected ${url}`));
  });
  const open = vi.fn();
  vi.stubGlobal("open", open);
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Документы" } });
  fireEvent.change(screen.getByTestId("file-drop-input"), {
    target: {
      files: [
        new File(["%PDF-1"], "first.pdf", { type: "application/pdf" }),
        new File(["%PDF-2"], "second.pdf", { type: "application/pdf" }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(await screen.findByRole("heading", { name: "Заявка BR-000042" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Скачать first.pdf" })).toBeDefined();
  expect(screen.getByText("second.pdf: не загружен — можно повторить")).toBeDefined();
  const retry = screen.getByRole("button", { name: "Повторить загрузку second.pdf" });
  retry.click();
  retry.click();
  expect(secondUploadCount).toBe(2);
  const secondUploadKeys = calls
    .filter(({ url }) => url.endsWith(`/api/billing/requests/${REQUEST_ID}/attachments`))
    .slice(1)
    .map(({ idempotencyKey }) => idempotencyKey);
  expect(secondUploadKeys).toEqual([KEY, KEY]);
  expect(await screen.findByText("second.pdf: загружается")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить загрузку second.pdf" })).toBeNull();
  resolveRetry(json(secondAttachment));
  const secondDownload = await screen.findByRole("button", { name: "Скачать second.pdf" });
  await waitFor(() =>
    expect(
      calls.filter(
        ({ url, method }) =>
          url.endsWith(`/api/billing/requests/${REQUEST_ID}`) && method === "GET",
      ),
    ).toHaveLength(1),
  );
  expect(screen.queryByText(/second\.pdf: (загружается|не загружен)/)).toBeNull();
  expect(screen.getAllByText("second.pdf")).toHaveLength(1);
  fireEvent.click(secondDownload);
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      "https://signed.example/second.pdf",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  expect(
    calls.filter(({ url, method }) => url.endsWith("/api/billing/requests") && method === "POST"),
  ).toHaveLength(1);
});

it("classifies initial upload network, 5xx, and 400 failures without recreating the request", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
  const attachmentErrors = [
    new Error("offline"),
    json({ code: "unavailable" }, 503),
    json({ code: "invalid_content" }, 400),
  ];
  let attachmentIndex = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/billing/requests") && init?.method === "POST") return json(request);
    if (url.endsWith(`/api/billing/requests/${REQUEST_ID}/attachments`)) {
      const result = attachmentErrors[attachmentIndex++];
      if (result instanceof Error) throw result;
      return result ?? json({ code: "unexpected" }, 500);
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  renderBilling(<CreateRequestPage />, "/billing/requests/new");
  fireEvent.change(screen.getByLabelText("Описание"), { target: { value: "Документы" } });
  fireEvent.change(screen.getByTestId("file-drop-input"), {
    target: {
      files: [
        new File(["one"], "network.txt", { type: "text/plain" }),
        new File(["two"], "server.txt", { type: "text/plain" }),
        new File(["three"], "invalid.txt", { type: "text/plain" }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать заявку" }));
  expect(await screen.findByText("network.txt: не загружен — можно повторить")).toBeDefined();
  expect(screen.getByText("server.txt: не загружен — можно повторить")).toBeDefined();
  expect(screen.getByText("invalid.txt: сервер отклонил файл")).toBeDefined();
  expect(screen.getByRole("button", { name: "Повторить загрузку network.txt" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Повторить загрузку server.txt" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить загрузку invalid.txt" })).toBeNull();
  expect(
    fetch.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/api/billing/requests") && init?.method === "POST",
    ),
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
