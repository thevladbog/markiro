import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { InvoiceDetailPage, InvoicesPage } from "../src/pages/billing/InvoicesPage.js";
import { useInvoice, useInvoices } from "../src/pages/billing/api.js";

vi.mock("../src/pages/billing/api.js", () => ({
  useInvoices: vi.fn(),
  useInvoice: vi.fn(),
  downloadInvoice: vi.fn(),
}));

const invoices = [
  ["issued", "100.00", "0.00", "100.00"],
  ["overdue", "200.00", "0.00", "200.00"],
  ["partially_paid", "300.00", "120.00", "180.00"],
  ["paid", "400.00", "400.00", "0.00"],
  ["cancelled", "500.00", null, null],
].map(([status, total, confirmedAmount, remainingAmount], index) => ({
  id: `00000000-0000-4000-8000-0000000000${index + 1}`,
  number: `Счёт №${index + 1}`,
  issueDate: "2026-08-01T00:00:00.000Z",
  dueDate: "2026-08-15T00:00:00.000Z",
  status,
  total,
  currency: "RUB",
  paymentSummary:
    confirmedAmount === null
      ? null
      : {
          confirmedAmount,
          remainingAmount: remainingAmount!,
          status: status === "overdue" ? "issued" : status,
        },
}));

function renderInvoices() {
  return render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter>
        <InvoicesPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows each authoritative invoice state with confirmed and remaining totals", () => {
  vi.mocked(useInvoices).mockReturnValue({
    data: { items: invoices },
    isPending: false,
    isError: false,
  } as never);

  renderInvoices();

  for (const label of ["Выставлено", "Просрочено", "Оплачено частично", "Оплачено", "Отменено"]) {
    expect(screen.getAllByText(label).length).toBeGreaterThan(1);
  }
  expect(screen.getAllByText(/Подтверждено: 120/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Остаток: 180/).length).toBeGreaterThan(0);
  expect(screen.getByRole("region", { name: "Реестр счетов" })).toBeDefined();
});

it("serializes only the status, from, and to invoice filters", () => {
  vi.mocked(useInvoices).mockReturnValue({
    data: { items: [] },
    isPending: false,
    isError: false,
  } as never);
  renderInvoices();

  fireEvent.change(screen.getByLabelText("Статус счёта"), { target: { value: "overdue" } });
  fireEvent.change(screen.getByLabelText("С даты"), { target: { value: "2026-08-01" } });
  fireEvent.change(screen.getByLabelText("По дату"), { target: { value: "2026-08-31" } });

  expect(vi.mocked(useInvoices).mock.calls.at(-1)?.[0]).toEqual({
    status: "overdue",
    from: "2026-08-01",
    to: "2026-08-31",
  });
});

it("keeps invoice and payment states separate and lists confirmed payments in API order", () => {
  vi.mocked(useInvoice).mockReturnValue({
    data: {
      ...invoices[2],
      subtotal: "250.00",
      vatTotal: "50.00",
      lines: [],
      documents: [],
      request: null,
      payments: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          amount: "20.00",
          currency: "RUB",
          paidAt: "2026-08-02T00:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          amount: "100.00",
          currency: "RUB",
          paidAt: "2026-08-04T00:00:00.000Z",
        },
      ],
    },
    isPending: false,
    isError: false,
  } as never);

  render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter initialEntries={["/billing/invoices/00000000-0000-4000-8000-000000000003"]}>
        <InvoiceDetailPage />
      </MemoryRouter>
    </ThemeProvider>,
  );

  expect(screen.getByText("Статус счёта")).toBeDefined();
  expect(screen.getByText("Статус оплаты")).toBeDefined();
  expect(screen.getByRole("heading", { name: "Подтверждённые оплаты", level: 3 })).toBeDefined();
  const paymentRows = screen.getAllByTestId("confirmed-payment");
  expect(paymentRows[0]?.textContent).toContain("20,00");
  expect(paymentRows[1]?.textContent).toContain("100,00");
  expect(screen.queryByText(/bank|банк|reference/i)).toBeNull();
});
