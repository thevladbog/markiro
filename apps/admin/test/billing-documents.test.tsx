import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { DocumentsPage } from "../src/pages/billing/DocumentsPage.js";
import {
  downloadActDocument,
  downloadOfferDocument,
  useDocuments,
} from "../src/pages/billing/api.js";

vi.mock("../src/pages/billing/api.js", () => ({
  useDocuments: vi.fn(),
  downloadOfferDocument: vi.fn(),
  downloadActDocument: vi.fn(),
}));

const documents = [
  {
    id: "00000000-0000-4000-8000-000000000021",
    type: "offer",
    entityId: "00000000-0000-4000-8000-000000000121",
    revision: 2,
    format: "pdf",
    status: "ready",
    contentType: "application/pdf",
    byteSize: 12,
    createdAt: "2026-08-03T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000022",
    type: "offer",
    entityId: "00000000-0000-4000-8000-000000000122",
    revision: 1,
    format: "pdf",
    status: "pending",
    contentType: null,
    byteSize: null,
    createdAt: "2026-08-02T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000023",
    type: "act",
    entityId: "00000000-0000-4000-8000-000000000123",
    revision: 1,
    format: "pdf",
    status: "failed",
    contentType: null,
    byteSize: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
];

function renderDocuments() {
  return render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter>
        <DocumentsPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.resetAllMocks();
  await i18n.changeLanguage("ru");
});

it("renders ready, pending, and failed documents as distinct textual states", () => {
  vi.mocked(useDocuments).mockReturnValue({
    data: { items: documents },
    isPending: false,
    isError: false,
  } as never);
  renderDocuments();
  expect(screen.getAllByText("Готов").length).toBeGreaterThan(1);
  expect(screen.getAllByText("Подготавливается").length).toBeGreaterThan(1);
  expect(screen.getAllByText("Не удалось подготовить").length).toBeGreaterThan(1);
  expect(screen.getAllByRole("button", { name: "Скачать" })).toHaveLength(1);
});

it("filters document type and period server-side, clears them, and keeps status local", () => {
  vi.mocked(useDocuments).mockReturnValue({
    data: { items: documents },
    isPending: false,
    isError: false,
  } as never);
  renderDocuments();
  fireEvent.change(screen.getByLabelText("Тип документа"), { target: { value: "act" } });
  fireEvent.change(screen.getByLabelText("С даты"), { target: { value: "2026-08-01" } });
  fireEvent.change(screen.getByLabelText("По дату"), { target: { value: "2026-08-31" } });
  expect(vi.mocked(useDocuments).mock.calls.at(-1)?.[0]).toEqual({
    type: "act",
    from: "2026-08-01",
    to: "2026-08-31",
  });
  fireEvent.change(screen.getByLabelText("Тип документа"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("С даты"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("По дату"), { target: { value: "" } });
  expect(vi.mocked(useDocuments).mock.calls.at(-1)?.[0]).toEqual({});
  fireEvent.change(screen.getByLabelText("Статус документа"), { target: { value: "failed" } });
  expect(screen.getAllByText("Не удалось подготовить").length).toBeGreaterThan(1);
});

it("renders document controls in Russian and English from the shared dictionaries", async () => {
  vi.mocked(useDocuments).mockReturnValue({
    data: { items: documents.slice(0, 1) },
    isPending: false,
    isError: false,
  } as never);
  renderDocuments();

  expect(screen.getByRole("heading", { name: "Документы" })).toBeDefined();
  expect(screen.getByLabelText("Тип документа")).toBeDefined();

  await i18n.changeLanguage("en");

  expect(screen.getByRole("heading", { name: "Documents" })).toBeDefined();
  expect(screen.getByLabelText("Document type")).toBeDefined();
  expect(screen.getByText("Commercial offer")).toBeDefined();
});

it("opens only a returned signed URL and reports a failed download", async () => {
  vi.mocked(useDocuments).mockReturnValue({
    data: { items: [documents[0]!] },
    isPending: false,
    isError: false,
  } as never);
  vi.mocked(downloadOfferDocument).mockRejectedValueOnce(new Error("offline"));
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  renderDocuments();
  fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Не удалось скачать"),
  );
  expect(open).not.toHaveBeenCalled();
  expect(downloadActDocument).not.toHaveBeenCalled();
});
