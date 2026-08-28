import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import type * as Domain from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import { ApiRequestError } from "../src/api/client.js";
import i18n from "../src/i18n/index.js";
import { OfferDetailPage } from "../src/pages/billing/OfferDetailPage.js";
import {
  acceptOffer,
  invalidateTenantBilling,
  requestOfferChanges,
  type OfferDecision,
  useOffer,
} from "../src/pages/billing/api.js";

// The worktree intentionally reuses the parent app's node_modules symlink.
// Pin the two Task 3 capability values here so this component test exercises
// the source contract rather than the parent worktree's stale domain build.
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

vi.mock("../src/pages/billing/api.js", () => ({
  useOffer: vi.fn(),
  acceptOffer: vi.fn(),
  requestOfferChanges: vi.fn(),
  downloadOfferDocument: vi.fn(),
  invalidateTenantBilling: vi.fn(async () => undefined),
}));

const offer = {
  id: "00000000-0000-4000-8000-000000000031",
  number: "КП-42",
  status: "published",
  total: "120.00",
  expiresAt: "2026-09-01T00:00:00.000Z",
  publishedAt: "2026-08-01T00:00:00.000Z",
  paidAt: null,
  termsMarkdown: "Условия",
  lines: [],
  documents: [],
  request: { id: "00000000-0000-4000-8000-000000000131", number: "З-42", status: "offer_prepared" },
  isCurrent: true,
  actionable: true,
  latestDecision: null,
};

function renderOffer(canRequest = true) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={[`/billing/offers/${offer.id}`]}>
          <AccessProvider
            value={{
              roles: canRequest ? ["owner"] : ["member"],
              capabilities: canRequest
                ? [CABINET_CAPABILITY.BILLING_READ, CABINET_CAPABILITY.BILLING_REQUEST]
                : [CABINET_CAPABILITY.BILLING_READ],
            }}
          >
            <OfferDetailPage />
          </AccessProvider>
        </MemoryRouter>
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

it.each(["expired", "superseded"])("renders %s offer as read-only", (status) => {
  vi.mocked(useOffer).mockReturnValue({
    data: {
      ...offer,
      status,
      actionable: false,
      isCurrent: status !== "superseded",
      latestDecision: null,
    },
    isPending: false,
    isError: false,
  } as never);
  renderOffer();
  expect(screen.queryByRole("button", { name: "Принять" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Запросить изменения" })).toBeNull();
});

it("uses the server-owned latest decision and actionable state after reload", () => {
  vi.mocked(useOffer).mockReturnValue({
    data: {
      ...offer,
      actionable: false,
      latestDecision: {
        decision: "accepted",
        message: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    },
    isPending: false,
    isError: false,
  } as never);
  renderOffer();
  expect(screen.getByText("Принято")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Принять" })).toBeNull();
});

it("renders accepted decision, paid lifecycle, and currentness as separate server fields", async () => {
  vi.mocked(useOffer).mockReturnValue({
    data: {
      ...offer,
      status: "paid",
      paidAt: "2026-08-03T00:00:00.000Z",
      isCurrent: true,
      actionable: false,
      latestDecision: {
        decision: "accepted",
        message: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    },
    isPending: false,
    isError: false,
  } as never);

  renderOffer();

  expect(screen.getByText("Оплачено")).toBeDefined();
  expect(screen.getByText("Текущая версия")).toBeDefined();
  expect(screen.getByText("Принято")).toBeDefined();

  await i18n.changeLanguage("en");

  expect(screen.getByText("Paid")).toBeDefined();
  expect(screen.getByText("Current revision")).toBeDefined();
  expect(screen.getByText("Accepted")).toBeDefined();
});

it("renders changes requested, superseded lifecycle, and non-currentness separately", async () => {
  vi.mocked(useOffer).mockReturnValue({
    data: {
      ...offer,
      status: "superseded",
      isCurrent: false,
      actionable: false,
      latestDecision: {
        decision: "changes_requested",
        message: "Уточнить количество",
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    },
    isPending: false,
    isError: false,
  } as never);

  renderOffer();

  expect(screen.getByText("Заменено новой версией")).toBeDefined();
  expect(screen.getByText("Не текущая версия")).toBeDefined();
  expect(screen.getByText("Изменения запрошены")).toBeDefined();
  expect(screen.getByText("Уточнить количество")).toBeDefined();

  await i18n.changeLanguage("en");

  expect(screen.getByText("Superseded by a newer revision")).toBeDefined();
  expect(screen.getByText("Not the current revision")).toBeDefined();
  expect(screen.getByText("Changes requested")).toBeDefined();
});

it("renders offer status and actions in Russian and English from the shared dictionaries", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  renderOffer();

  expect(screen.getByRole("heading", { name: "Предложение КП-42" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Принять" })).toBeDefined();

  await i18n.changeLanguage("en");

  expect(screen.getByRole("heading", { name: "Offer КП-42" })).toBeDefined();
  expect(screen.getByText("Active")).toBeDefined();
  expect(screen.getByRole("button", { name: "Accept" })).toBeDefined();
});

it.each([
  [404, "Предложение не найдено"],
  [403, "Нет доступа к предложению"],
] as const)("renders offer detail HTTP %s without a retry action", (status, title) => {
  vi.mocked(useOffer).mockReturnValue({
    data: undefined,
    isPending: false,
    isError: true,
    error: new ApiRequestError(status, title),
    refetch: vi.fn(),
  } as never);

  renderOffer();

  expect(screen.getByText(title)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
});

it.each([new ApiRequestError(503, "unavailable"), new Error("offline")])(
  "renders a retryable offer detail load error for %s",
  (error) => {
    const refetch = vi.fn();
    vi.mocked(useOffer).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error,
      refetch,
    } as never);

    renderOffer();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(screen.getByText("Не удалось загрузить предложение")).toBeDefined();
    expect(refetch).toHaveBeenCalledTimes(1);
  },
);

it("requires confirmation, locks acceptance immediately, and retains one retry key", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  const uuid = vi.fn(() => "00000000-0000-4000-8000-000000000099");
  vi.stubGlobal("crypto", { randomUUID: uuid });
  let reject!: (reason?: unknown) => void;
  vi.mocked(acceptOffer).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  vi.mocked(acceptOffer).mockResolvedValueOnce({
    id: "decision",
    offerId: offer.id,
    decision: "accepted",
    message: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить принятие" }));
  expect(
    screen.getByRole("button", { name: "Подтвердить принятие" }).hasAttribute("disabled"),
  ).toBe(true);
  reject(new Error("offline"));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(acceptOffer).toHaveBeenCalledTimes(2));
  expect(vi.mocked(acceptOffer).mock.calls[0]?.[1]).toBe(vi.mocked(acceptOffer).mock.calls[1]?.[1]);
  expect(uuid).toHaveBeenCalledTimes(1);
});

it("locks acceptance before two clicks can create a second POST", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  let resolve!: (value: OfferDecision) => void;
  vi.mocked(acceptOffer).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  const confirm = screen.getByRole("button", { name: "Подтвердить принятие" });

  act(() => {
    confirm.click();
    confirm.click();
  });

  expect(acceptOffer).toHaveBeenCalledTimes(1);
  expect(confirm.hasAttribute("disabled")).toBe(true);
  await act(async () => {
    resolve({
      id: "decision",
      offerId: offer.id,
      decision: "accepted",
      message: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });
});

it("retries a change request with the exact trimmed message and immutable key", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000091"),
  });
  vi.mocked(requestOfferChanges).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
    id: "decision",
    offerId: offer.id,
    decision: "changes_requested",
    message: "Изменить срок",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Запросить изменения" }));
  fireEvent.change(screen.getByLabelText("Что нужно изменить"), {
    target: { value: "  Изменить срок  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(requestOfferChanges).toHaveBeenCalledTimes(2));

  expect(vi.mocked(requestOfferChanges).mock.calls).toEqual([
    [offer.id, "Изменить срок", "00000000-0000-4000-8000-000000000091"],
    [offer.id, "Изменить срок", "00000000-0000-4000-8000-000000000091"],
  ]);
});

it("editing after an ambiguous failure removes Retry and creates a new payload and key", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  const uuid = vi
    .fn()
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000092")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000093");
  vi.stubGlobal("crypto", { randomUUID: uuid });
  vi.mocked(requestOfferChanges).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
    id: "decision",
    offerId: offer.id,
    decision: "changes_requested",
    message: "Новый текст",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Запросить изменения" }));
  const textarea = screen.getByLabelText("Что нужно изменить");
  fireEvent.change(textarea, { target: { value: "Первый текст" } });
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  await screen.findByRole("button", { name: "Повторить" });

  fireEvent.change(textarea, { target: { value: "Новый текст" } });

  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  await waitFor(() => expect(requestOfferChanges).toHaveBeenCalledTimes(2));
  expect(vi.mocked(requestOfferChanges).mock.calls).toEqual([
    [offer.id, "Первый текст", "00000000-0000-4000-8000-000000000092"],
    [offer.id, "Новый текст", "00000000-0000-4000-8000-000000000093"],
  ]);
});

it("switching actions clears the retained attempt instead of retrying the wrong action", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  vi.mocked(acceptOffer).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(requestOfferChanges).mockResolvedValueOnce({
    id: "decision",
    offerId: offer.id,
    decision: "changes_requested",
    message: "Исправить цену",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить принятие" }));
  await screen.findByRole("button", { name: "Повторить" });

  fireEvent.click(screen.getByRole("button", { name: "Запросить изменения" }));

  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Что нужно изменить"), {
    target: { value: "Исправить цену" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  await waitFor(() => expect(requestOfferChanges).toHaveBeenCalledTimes(1));
  expect(acceptOffer).toHaveBeenCalledTimes(1);
});

it.each([
  ["offer_version_stale", "Предложение заменено новой версией. Данные обновлены."],
  ["offer_expired", "Срок действия предложения истёк. Данные обновлены."],
  ["offer_already_decided", "Решение по предложению уже зафиксировано. Данные обновлены."],
  ["idempotency_key_reused", "Повтор запроса не совпал с исходным решением. Данные обновлены."],
] as const)("refreshes authority and makes %s non-retryable", async (code, message) => {
  const refetch = vi.fn(async () => ({ data: undefined }));
  vi.mocked(useOffer).mockReturnValue({
    data: offer,
    isPending: false,
    isError: false,
    refetch,
  } as never);
  vi.mocked(acceptOffer).mockRejectedValueOnce(new ApiRequestError(409, "conflict", code));
  vi.mocked(invalidateTenantBilling).mockResolvedValueOnce(undefined);
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Принять" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить принятие" }));

  expect(await screen.findByText(message)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  expect(invalidateTenantBilling).toHaveBeenCalledTimes(1);
  expect(refetch).toHaveBeenCalledTimes(1);
});

it("validates change request length and capability-gates action controls", async () => {
  vi.mocked(useOffer).mockReturnValue({ data: offer, isPending: false, isError: false } as never);
  const denied = renderOffer(false);
  expect(screen.queryByRole("button", { name: "Принять" })).toBeNull();
  denied.unmount();
  renderOffer();
  fireEvent.click(screen.getByRole("button", { name: "Запросить изменения" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  expect(screen.getByRole("alert").textContent).toContain("от 1 до 2000");
  fireEvent.change(screen.getByLabelText("Что нужно изменить"), {
    target: { value: "Изменить срок" },
  });
  vi.mocked(requestOfferChanges).mockResolvedValueOnce({
    id: "decision",
    offerId: offer.id,
    decision: "changes_requested",
    message: "Изменить срок",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  fireEvent.click(screen.getByRole("button", { name: "Отправить запрос" }));
  await waitFor(() => expect(requestOfferChanges).toHaveBeenCalledTimes(1));
});
