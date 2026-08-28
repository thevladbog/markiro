import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import type * as Domain from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import { ApiRequestError } from "../src/api/client.js";
import i18n from "../src/i18n/index.js";
import { RequestDetailPage } from "../src/pages/billing/RequestDetailPage.js";
import {
  downloadRequestAttachment,
  invalidateTenantBillingRequests,
  replyToBillingRequest,
  type BillingRequestQuery,
  type TenantBillingRequestDetail,
  uploadBillingRequestAttachment,
  useBillingRequest,
} from "../src/pages/billing/api.js";
import type * as BillingApi from "../src/pages/billing/api.js";

vi.mock("@markiro/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof Domain>();
  return {
    ...actual,
    CABINET_CAPABILITY: {
      ...actual.CABINET_CAPABILITY,
      BILLING_READ: "billing.read",
      BILLING_REQUEST: "billing.request",
    },
  };
});

vi.mock("../src/pages/billing/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BillingApi>();
  return {
    ...actual,
    useBillingRequest: vi.fn(),
    replyToBillingRequest: vi.fn(),
    downloadRequestAttachment: vi.fn(),
    uploadBillingRequestAttachment: vi.fn(),
    invalidateTenantBillingRequests: vi.fn(async () => undefined),
  };
});

const ID = "00000000-0000-4000-8000-000000000501";
const detail: TenantBillingRequestDetail = {
  id: ID,
  number: "BR-000042",
  type: "capacity_change",
  status: "clarification_required",
  description: "Добавить две линии",
  desiredAt: "2026-09-10T00:00:00.000Z",
  context: { type: "limit", id: "lines" },
  responsibleSide: "tenant",
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T09:00:00.000Z",
  attachments: [
    {
      id: "00000000-0000-4000-8000-000000000601",
      fileName: "brief.pdf",
      contentType: "application/pdf",
      byteSize: 1024,
      sha256: "secret-hash",
      createdAt: "2026-08-28T08:05:00.000Z",
    },
  ],
  links: [
    {
      id: "00000000-0000-4000-8000-000000000701",
      offerId: "00000000-0000-4000-8000-000000000711",
      invoiceId: null,
      paymentId: null,
      actId: null,
      orderedServiceId: null,
      subscriptionEventId: null,
      createdAt: "2026-08-28T08:30:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000702",
      offerId: null,
      invoiceId: "00000000-0000-4000-8000-000000000712",
      paymentId: null,
      actId: null,
      orderedServiceId: null,
      subscriptionEventId: null,
      createdAt: "2026-08-28T08:40:00.000Z",
    },
  ],
  events: [
    {
      id: "00000000-0000-4000-8000-000000000802",
      kind: "platform_comment",
      fromStatus: null,
      toStatus: null,
      actorKind: "platform_user",
      message: "Уточните количество линий",
      metadata: null,
      createdAt: "2026-08-28T09:00:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000801",
      kind: "created",
      fromStatus: null,
      toStatus: null,
      actorKind: "tenant_user",
      message: null,
      metadata: { type: "capacity_change" },
      createdAt: "2026-08-28T08:00:00.000Z",
    },
  ],
};

function requestQuery(
  data: TenantBillingRequestDetail = detail,
  overrides: Partial<BillingRequestQuery> = {},
): BillingRequestQuery {
  return {
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderDetail(
  canMutate = true,
  attachmentUploads: Array<{ file: File; state: string }> = [],
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider defaultTheme="light">
        <AccessProvider
          value={{
            roles: [canMutate ? "owner" : "admin"],
            capabilities: canMutate
              ? [CABINET_CAPABILITY.BILLING_READ, CABINET_CAPABILITY.BILLING_REQUEST]
              : [CABINET_CAPABILITY.BILLING_READ],
          }}
        >
          <MemoryRouter
            initialEntries={[
              {
                pathname: `/billing/requests/${ID}`,
                state: { attachmentUploads },
              },
            ]}
          >
            <Routes>
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
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps a retryable attachment failure textual but non-actionable after capability revocation", () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  renderDetail(false, [
    {
      file: new File(["plain"], "revoked.txt", { type: "text/plain" }),
      state: "failed_retryable",
    },
  ]);
  expect(screen.getByText("revoked.txt: не загружен — можно повторить")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить загрузку revoked.txt" })).toBeNull();
  expect(uploadBillingRequestAttachment).not.toHaveBeenCalled();
});

it("uses a synchronous single-flight lock and restores retry after a network failure", async () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  let reject!: (reason: unknown) => void;
  vi.mocked(uploadBillingRequestAttachment).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  renderDetail(true, [
    {
      file: new File(["plain"], "network.txt", { type: "text/plain" }),
      state: "failed_retryable",
    },
  ]);
  const retry = screen.getByRole("button", { name: "Повторить загрузку network.txt" });
  retry.click();
  retry.click();
  expect(uploadBillingRequestAttachment).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("network.txt: загружается")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить загрузку network.txt" })).toBeNull();
  reject(new Error("offline"));
  expect(
    await screen.findByRole("button", { name: "Повторить загрузку network.txt" }),
  ).toBeDefined();
});

it.each([
  {
    failure: new ApiRequestError(503, "unavailable", "unavailable"),
    message: "server.txt: не загружен — можно повторить",
    retry: true,
  },
  {
    failure: new ApiRequestError(400, "invalid", "invalid_content"),
    message: "server.txt: сервер отклонил файл",
    retry: false,
  },
])("classifies retry upload failure as $message", async ({ failure, message, retry }) => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  vi.mocked(uploadBillingRequestAttachment).mockRejectedValueOnce(failure);
  renderDetail(true, [
    {
      file: new File(["plain"], "server.txt", { type: "text/plain" }),
      state: "failed_retryable",
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку server.txt" }));
  expect(await screen.findByText(message)).toBeDefined();
  if (retry) {
    expect(screen.getByRole("button", { name: "Повторить загрузку server.txt" })).toBeDefined();
  } else {
    expect(screen.queryByRole("button", { name: "Повторить загрузку server.txt" })).toBeNull();
  }
  expect(uploadBillingRequestAttachment).toHaveBeenCalledTimes(1);
});

it("renders exact request fields, links, attachment states, and chronological non-chat events", () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  renderDetail();
  expect(screen.getByRole("heading", { name: "Заявка BR-000042" })).toBeDefined();
  expect(screen.getByText("Добавить две линии")).toBeDefined();
  expect(screen.getByText("Ответственная сторона")).toBeDefined();
  expect(screen.getByText("Лимит — Линии")).toBeDefined();
  expect(screen.getAllByText("Клиент").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Коммерческое предложение" }).getAttribute("href")).toBe(
    "/billing/offers/00000000-0000-4000-8000-000000000711",
  );
  expect(screen.getByRole("link", { name: "Счёт" }).getAttribute("href")).toBe(
    "/billing/invoices/00000000-0000-4000-8000-000000000712",
  );
  expect(screen.getByRole("button", { name: "Скачать brief.pdf" })).toBeDefined();
  expect(screen.queryByText("secret-hash")).toBeNull();
  const history = screen.getByRole("list", { name: "История заявки" });
  const events = within(history).getAllByRole("listitem");
  expect(events[0]?.textContent).toContain("Клиент");
  expect(events[0]?.textContent).toContain("Заявка создана");
  expect(events[0]?.textContent).toContain("Создана заявка");
  expect(events[1]?.textContent).toContain("Markiro");
  expect(events[1]?.textContent).toContain("Комментарий");
  expect(events[1]?.textContent).toContain("Уточните количество линий");
  expect(events[0]?.className).not.toContain("chat");
});

it("opens only an API-returned signed URL and surfaces download failure", async () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  const open = vi.fn();
  vi.stubGlobal("open", open);
  vi.mocked(downloadRequestAttachment)
    .mockResolvedValueOnce({ url: "https://signed.example/brief.pdf" })
    .mockRejectedValueOnce(new Error("offline"));
  renderDetail();
  const button = screen.getByRole("button", { name: "Скачать brief.pdf" });
  fireEvent.click(button);
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      "https://signed.example/brief.pdf",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  fireEvent.click(button);
  expect(await screen.findByText("Не удалось скачать вложение.")).toBeDefined();
});

it("shows clarification reply only with status and capability and supports RU/EN", async () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  const denied = renderDetail(false);
  expect(screen.queryByLabelText("Ответ на уточнение")).toBeNull();
  denied.unmount();
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery({ ...detail, status: "under_review" }));
  const wrongStatus = renderDetail(true);
  expect(screen.queryByLabelText("Ответ на уточнение")).toBeNull();
  wrongStatus.unmount();
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  renderDetail(true);
  expect(screen.getByLabelText("Ответ на уточнение")).toBeDefined();
  await i18n.changeLanguage("en");
  expect(screen.getByLabelText("Clarification reply")).toBeDefined();
  expect(screen.getAllByText("Customer").length).toBeGreaterThan(0);
});

it("retains trimmed reply and key on ambiguous retry, locks double clicks, then invalidates exact prefixes", async () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  const uuid = vi.fn(() => "00000000-0000-4000-8000-000000000999");
  vi.stubGlobal("crypto", { randomUUID: uuid });
  let reject!: (reason: unknown) => void;
  const replyEvent = detail.events.at(0);
  if (!replyEvent) throw new Error("request event fixture is missing");
  vi.mocked(replyToBillingRequest)
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValueOnce(replyEvent);
  renderDetail();
  fireEvent.change(screen.getByLabelText("Ответ на уточнение"), {
    target: { value: "  Нужно 2 линии  " },
  });
  const submit = screen.getByRole("button", { name: "Отправить ответ" });
  submit.click();
  submit.click();
  expect(replyToBillingRequest).toHaveBeenCalledTimes(1);
  reject(new Error("offline"));
  fireEvent.click(await screen.findByRole("button", { name: "Повторить отправку" }));
  await waitFor(() => expect(replyToBillingRequest).toHaveBeenCalledTimes(2));
  expect(vi.mocked(replyToBillingRequest).mock.calls).toEqual([
    [ID, "Нужно 2 линии", "00000000-0000-4000-8000-000000000999"],
    [ID, "Нужно 2 линии", "00000000-0000-4000-8000-000000000999"],
  ]);
  expect(screen.getByLabelText("Ответ на уточнение")).toHaveProperty("value", "");
  expect(uuid).toHaveBeenCalledTimes(1);
  expect(invalidateTenantBillingRequests).toHaveBeenCalledWith(expect.any(QueryClient), ID);
});

it.each([
  new ApiRequestError(400, "invalid", "validation_failed"),
  new ApiRequestError(409, "conflict", "billing_request_not_awaiting_clarification"),
])("treats terminal reply failures as non-retryable and refetches authority", async (error) => {
  const refetch = vi.fn();
  vi.mocked(useBillingRequest).mockReturnValue(
    requestQuery(detail, { refetch: async () => refetch() }),
  );
  vi.mocked(replyToBillingRequest).mockRejectedValueOnce(error);
  renderDetail();
  fireEvent.change(screen.getByLabelText("Ответ на уточнение"), {
    target: { value: "Ответ" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  expect(await screen.findByText("Состояние заявки изменилось. Данные обновлены.")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
  expect(screen.getByLabelText("Ответ на уточнение")).toHaveProperty("value", "Ответ");
  expect(refetch).toHaveBeenCalledTimes(1);
});

it("validates the exact 1-2000 reply bounds", () => {
  vi.mocked(useBillingRequest).mockReturnValue(requestQuery());
  renderDetail();
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  expect(screen.getByText("Ответ должен содержать от 1 до 2000 символов.")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Ответ на уточнение"), {
    target: { value: "x".repeat(2001) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить ответ" }));
  expect(replyToBillingRequest).not.toHaveBeenCalled();
});
