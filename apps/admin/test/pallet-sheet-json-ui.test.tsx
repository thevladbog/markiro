import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { CABINET_CAPABILITY, buildPalletSheetPresets } from "@markiro/domain";
import { analyzeSheetImport } from "../src/pages/labels/editor/sheet/sheet-import.js";
import { AccessProvider } from "../src/access/context.js";
import { LabelTemplatesPage } from "../src/pages/labels/index.js";
import {
  SheetTemplatePage,
  type SheetTemplateRecord,
} from "../src/pages/labels/editor/sheet/SheetTemplatePage.js";
function getPreset() {
  const value = buildPalletSheetPresets()[0];
  if (!value) throw new Error("Missing preset");
  return value;
}
const preset = getPreset();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function renderPage(template?: SheetTemplateRecord) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <MemoryRouter>
        <SheetTemplatePage initialPresetKey={preset.key} {...(template ? { template } : {})} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("A4 template JSON boundary", () => {
  it("keeps an imported draft editable and preserves all V2 settings", () => {
    const outcome = analyzeSheetImport(
      JSON.stringify({ name: "Импорт", purpose: "pallet", spec: preset.spec }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: { name: "Импорт", purpose: "pallet", spec: preset.spec },
    });
  });
  it("reports a path for an invalid node and rejects unsupported versions", () => {
    const invalid = { ...preset.spec, footer: { ...preset.spec.footer, barHeightMm: 10 } };
    expect(
      analyzeSheetImport(JSON.stringify({ name: "A4", purpose: "pallet", spec: invalid })),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "footer.barHeightMm" })],
    });
    expect(analyzeSheetImport(JSON.stringify({ ...preset.spec, schemaVersion: 3 })).ok).toBe(false);
    expect(
      analyzeSheetImport(JSON.stringify({ name: "A4", purpose: "box", spec: preset.spec })).ok,
    ).toBe(false);
  });
  it("cancelling pasted JSON preserves the original draft; apply then save creates a new record", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { id: "new-sheet", ...JSON.parse(String(init.body)), revision: 1 }
              : { items: [] },
          ),
          {
            status: init?.method === "POST" ? 201 : 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const name = screen.getByLabelText<HTMLInputElement>("Название шаблона");
    fireEvent.click(screen.getByRole("button", { name: "Импорт JSON" }));
    fireEvent.change(screen.getByLabelText("JSON шаблона"), {
      target: { value: JSON.stringify({ name: "Новый А4", purpose: "pallet", spec: preset.spec }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(name.value).toBe(preset.name);
    fireEvent.click(screen.getByRole("button", { name: "Импорт JSON" }));
    fireEvent.change(screen.getByLabelText("JSON шаблона"), {
      target: { value: JSON.stringify({ name: "Новый А4", purpose: "pallet", spec: preset.spec }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    expect(name.value).toBe("Новый А4");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
    );
    const sent = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body;
    expect(JSON.parse(String(sent))).toMatchObject({
      name: "Новый А4",
      purpose: "pallet",
      spec: preset.spec,
      format: "pallet_sheet_v2",
    });
    expect(JSON.parse(String(sent))).not.toHaveProperty("id");
  });
  it("ignores a file read from a cancelled import and accepts the current JSON file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    renderPage();
    let finishRead: ((text: string) => void) | undefined;
    const slow = new File(["slow"], "old.json", { type: "application/json" });
    Object.defineProperty(slow, "text", {
      value: () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Импорт JSON" }));
    fireEvent.change(screen.getByLabelText("Файл JSON"), { target: { files: [slow] } });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Импорт JSON" }));
    await act(async () => {
      finishRead?.(JSON.stringify({ name: "Old", purpose: "pallet", spec: preset.spec }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>("JSON шаблона").value).toBe(""),
    );
    const text = JSON.stringify({ name: "From file", purpose: "pallet", spec: preset.spec });
    const file = new File([text], "new.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => text });
    fireEvent.change(screen.getByLabelText("Файл JSON"), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>("JSON шаблона").value).toBe(text),
    );
    fireEvent.click(screen.getByRole("button", { name: "Проверить JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    expect(screen.getByLabelText<HTMLInputElement>("Название шаблона").value).toBe("From file");
  });
  it("preserves the draft after a revision conflict and saves a copy without the source revision", async () => {
    const record: SheetTemplateRecord = {
      id: "sheet-1",
      name: "Saved",
      spec: preset.spec,
      revision: 3,
      enabled: true,
      chzProductGroupCodes: null,
    };
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "PATCH"
              ? { code: "LABEL_TEMPLATE_REVISION_CONFLICT", message: "Conflict" }
              : { id: "copy", ...JSON.parse(String(init?.body)), revision: 1 },
          ),
          { status: init?.method === "PATCH" ? 409 : 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage(record);
    const name = screen.getByLabelText<HTMLInputElement>("Название шаблона");
    fireEvent.change(name, { target: { value: "My draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText(/Шаблон изменён другим пользователем/);
    expect(name.value).toBe("My draft");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body;
    expect(JSON.parse(String(patch))).toMatchObject({ name: "My draft", expectedRevision: 3 });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Создать копию" })[0] ??
        screen.getByRole("button", { name: "Создать копию" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
    );
    const post = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body),
    );
    expect(post).toMatchObject({ name: "My draft (копия)", spec: preset.spec });
    expect(post).not.toHaveProperty("expectedRevision");
    expect(post).not.toHaveProperty("id");
  });
  it("shows and filters sheets without a printer-language field, opting into the API format", async () => {
    const summary = {
      id: "sheet-1",
      name: "А4 тест",
      purpose: "pallet",
      format: "pallet_sheet_v2",
      revision: 3,
      page: { size: "A4", orientation: "portrait", copies: 1 },
      dpi: 300,
      enabled: true,
      chzProductGroupCodes: null,
      updatedAt: "2026-10-10T00:00:00Z",
    };
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            url.endsWith("chz-product-groups")
              ? { items: [] }
              : url.endsWith("enabled=all")
                ? { items: [summary] }
                : init?.method === "PATCH"
                  ? { ...summary, spec: preset.spec, enabled: false, revision: 4 }
                  : { ...summary, spec: preset.spec },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <AccessProvider
            value={{ roles: [], capabilities: [CABINET_CAPABILITY.OPERATIONS_WRITE] }}
          >
            <LabelTemplatesPage />
          </AccessProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("А4 тест");
    expect(screen.getByText("210.0×297.0 мм")).toBeDefined();
    expect(
      new Headers(
        fetchMock.mock.calls.find(([url]) => url.endsWith("enabled=all"))?.[1]?.headers,
      ).get("x-label-template-formats"),
    ).toBe("label-v1,pallet-sheet-v2");
    fireEvent.click(screen.getByRole("button", { name: "Этикетки" }));
    expect(screen.queryByText("А4 тест")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Листы А4" }));
    await screen.findByText("А4 тест");
    fireEvent.click(screen.getByRole("button", { name: "Выключить" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true),
    );
    expect(
      JSON.parse(
        String(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body),
      ),
    ).toEqual({ enabled: false, expectedRevision: 3 });
  });
});
