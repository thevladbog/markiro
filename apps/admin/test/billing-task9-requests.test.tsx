import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type * as ApiClient from "../src/api/client.js";
import i18n from "../src/i18n/index.js";
import { DocumentsPage } from "../src/pages/billing/DocumentsPage.js";
import { InvoicesPage } from "../src/pages/billing/InvoicesPage.js";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("../src/api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return { ...actual, apiFetch };
});

function renderWithQueries(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>{element}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  apiFetch.mockReset();
  await i18n.changeLanguage("ru");
});

it("omits invoice date keys from the later request after both controls are cleared", async () => {
  apiFetch.mockResolvedValue({ items: [] });
  renderWithQueries(<InvoicesPage />);
  await screen.findByText("Счетов по выбранным фильтрам нет");

  fireEvent.change(screen.getByLabelText("С даты"), { target: { value: "2026-08-01" } });
  fireEvent.change(await screen.findByLabelText("По дату"), {
    target: { value: "2026-08-31" },
  });
  await waitFor(() =>
    expect(apiFetch).toHaveBeenLastCalledWith("/billing/invoices?from=2026-08-01&to=2026-08-31"),
  );

  fireEvent.change(await screen.findByLabelText("С даты"), { target: { value: "" } });
  fireEvent.change(await screen.findByLabelText("По дату"), { target: { value: "" } });
  await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith("/billing/invoices"));
});

it("omits document type and date keys from the later request after controls are cleared", async () => {
  apiFetch.mockResolvedValue({ items: [] });
  renderWithQueries(<DocumentsPage />);
  await screen.findByText("Документы по выбранным фильтрам не найдены");

  fireEvent.change(screen.getByLabelText("Тип документа"), { target: { value: "offer" } });
  fireEvent.change(await screen.findByLabelText("С даты"), {
    target: { value: "2026-08-01" },
  });
  fireEvent.change(await screen.findByLabelText("По дату"), {
    target: { value: "2026-08-31" },
  });
  await waitFor(() =>
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/billing/documents?type=offer&from=2026-08-01&to=2026-08-31",
    ),
  );

  fireEvent.change(await screen.findByLabelText("Тип документа"), { target: { value: "" } });
  fireEvent.change(await screen.findByLabelText("С даты"), { target: { value: "" } });
  fireEvent.change(await screen.findByLabelText("По дату"), { target: { value: "" } });
  await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith("/billing/documents"));
});
