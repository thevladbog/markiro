import { describe, expect, it } from "vitest";
import {
  buildPalletSheetPresets,
  parsePalletSheetSpec,
  type PalletSheetSpecV2,
} from "@markiro/domain";
import {
  createSheetHistory,
  sheetHistoryReducer,
  insertSheetNode,
  moveSheetNode,
  removeSheetNode,
  replaceSheetNode,
} from "../src/pages/labels/editor/sheet/useSheetSpecState.js";
const preset = buildPalletSheetPresets()[0];
if (!preset) throw new Error("Missing preset");
const spec = preset.spec;
describe("editable sheet tree and history", () => {
  it("adds to a row, reorders, moves between parents, and removes without mutating the source", () => {
    const node = { id: "extra", kind: "text" as const, text: "Extra", fontSizePt: 8 };
    const added = insertSheetNode(spec, "header", node);
    const moved = moveSheetNode(added, "extra", null, 0);
    expect(moved.body[0]).toEqual(node);
    expect(spec.body).not.toContainEqual(node);
    expect(removeSheetNode(moved, "extra")).toEqual(spec);
    expect(parsePalletSheetSpec(moved)).toEqual(moved);
  });
  it("rejects cycles and moving the mandatory footer", () => {
    expect(() => moveSheetNode(spec, "header", "organization", 0)).toThrow(/cycle/i);
    expect(() => removeSheetNode(spec, spec.footer.id)).toThrow(/footer/i);
  });
  it("updates canvas coordinates and preserves other nodes", () => {
    const canvas = insertSheetNode(spec, null, {
      id: "canvas",
      kind: "canvas",
      heightMm: 20,
      children: [
        { id: "position", kind: "text", text: "Text", fontSizePt: 6, xMm: 1, yMm: 1, widthMm: 20 },
      ],
    });
    const changed = replaceSheetNode(canvas, "position", (node) => ({ ...node, xMm: 5, yMm: 3 }));
    expect(changed.body.slice(0, -1)).toEqual(spec.body);
    expect(parsePalletSheetSpec(changed).body.at(-1)).toMatchObject({
      children: [{ xMm: 5, yMm: 3 }],
    });
  });
  it("applies an import as one undoable transaction, undo/redo, then clears redo on edit", () => {
    let state = createSheetHistory(spec);
    const changed = { ...spec, body: [] };
    state = sheetHistoryReducer(state, { type: "change", spec: changed });
    expect(state.present).toEqual(changed);
    state = sheetHistoryReducer(state, { type: "undo" });
    expect(state.present).toEqual(spec);
    state = sheetHistoryReducer(state, { type: "redo" });
    expect(state.present).toEqual(changed);
    state = sheetHistoryReducer(state, { type: "undo" });
    state = sheetHistoryReducer(state, {
      type: "change",
      spec: { ...spec, footer: { ...spec.footer, barHeightMm: 50 } },
    });
    expect(state.future).toEqual([]);
  });
});
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { useState } from "react";
import { SheetEditor } from "../src/pages/labels/editor/sheet/SheetEditor.js";
afterEach(cleanup);
it("edits text, a presence condition and page settings through visible controls", () => {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState<PalletSheetSpecV2>({ ...spec, body: [] });
    return (
      <SheetEditor
        value={value}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Добавить: Текст" }));
  fireEvent.change(screen.getByLabelText("Текст элемента"), { target: { value: "My heading" } });
  expect(changed.mock.lastCall?.[0].body[0]).toMatchObject({ kind: "text", text: "My heading" });
  fireEvent.pointerDown(screen.getByRole("combobox", { name: "Показывать, если поле заполнено" }), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("option", { name: "Дата производства" }));
  expect(changed.mock.lastCall?.[0].body[0]).toMatchObject({
    when: { field: "productionDate", op: "present" },
  });
  fireEvent.change(screen.getByLabelText("Высота штрихов SSCC, мм"), { target: { value: "50" } });
  expect(changed.mock.lastCall?.[0].footer.barHeightMm).toBe(50);
  expect(
    screen.getByText("SSCC закреплён внизу каждой этикетки; тихие зоны сохраняются."),
  ).toBeDefined();
});
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SheetTemplatePage } from "../src/pages/labels/editor/sheet/SheetTemplatePage.js";
it("re-arms reload and route guards after saving an existing template without remounting", async () => {
  const template = {
    id: "sheet",
    name: "A4",
    revision: 1,
    enabled: true,
    chzProductGroupCodes: null,
    spec,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) =>
      Response.json(
        init?.method === "PATCH"
          ? { ...template, revision: 2 }
          : String(_url).includes("print-branding")
            ? { organizationName: "Plant", logoRevision: null, logoUrl: null, logo: null }
            : { items: [] },
      ),
    ),
  );
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/labels/:id",
        element: (
          <QueryClientProvider client={query}>
            <Link to="/other">Other page</Link>
            <SheetTemplatePage template={template} />
          </QueryClientProvider>
        ),
      },
      { path: "/other", element: <p>Other destination</p> },
    ],
    { initialEntries: ["/labels/sheet"] },
  );
  const originalKey = router.state.location.key;
  render(<RouterProvider router={router} />);
  fireEvent.change(screen.getByLabelText("Название шаблона"), { target: { value: "Saved" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(router.state.location.key).not.toBe(originalKey));
  fireEvent.change(screen.getByLabelText("Название шаблона"), {
    target: { value: "Unsaved after save" },
  });
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  await screen.findByText("Несохранённые изменения");
  expect(screen.queryByText("Other destination")).toBeNull();
  vi.unstubAllGlobals();
});
it("blocks unrelated route navigation with a dirty A4 draft until discard is confirmed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
  );
  const router = createMemoryRouter(
    [
      {
        path: "/editor",
        element: (
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <Link to="/other">Other page</Link>
            <SheetTemplatePage initialPresetKey="blank" />
          </QueryClientProvider>
        ),
      },
      { path: "/other", element: <p>Other destination</p> },
    ],
    { initialEntries: ["/editor"] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.change(screen.getByLabelText("Название шаблона"), { target: { value: "Dirty" } });
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  await screen.findByText("Несохранённые изменения");
  expect(screen.queryByText("Other destination")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.getByLabelText<HTMLInputElement>("Название шаблона").value).toBe("Dirty");
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  fireEvent.click(await screen.findByRole("button", { name: "Отбросить правки" }));
  await screen.findByText("Other destination");
  vi.unstubAllGlobals();
});
