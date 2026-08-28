import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import type * as Domain from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import { OfferDetailPage } from "../src/pages/billing/OfferDetailPage.js";
import { acceptOffer, requestOfferChanges, useOffer } from "../src/pages/billing/api.js";

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
};

function renderOffer(canRequest = true) {
  return render(
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
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each(["expired", "superseded", "accepted", "changes_requested"])(
  "renders %s offer as read-only",
  (status) => {
    vi.mocked(useOffer).mockReturnValue({
      data: { ...offer, status },
      isPending: false,
      isError: false,
    } as never);
    renderOffer();
    expect(screen.queryByRole("button", { name: "Принять" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Запросить изменения" })).toBeNull();
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
