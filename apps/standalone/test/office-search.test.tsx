import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { useState } from "react";

import type { OfficeSearchResponse, OfficeSearchTarget } from "../src/host/office-search.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { OfficeSearch } from "../src/office/search/OfficeSearch.js";
import { fakeHostApi, fakeOfficeSession } from "./support/office.js";

const response: OfficeSearchResponse = {
  items: [
    {
      id: "p1",
      label: "Палет (00)146006820000000409",
      detail: "Закрыт",
      target: { kind: "warehouse_pallet", id: "p1" },
    },
  ],
  truncated: false,
};

function mount(scan?: string, search = vi.fn(async () => response)) {
  const api = fakeHostApi({ searchOffice: search });
  const session = fakeOfficeSession({ api });
  const onSelect = vi.fn<(target: OfficeSearchTarget) => void>();
  const onClose = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <OfficeSearch
        {...(scan === undefined ? {} : { scan: { id: 1, raw: scan } })}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        onSelect={onSelect}
      />
    ) : null;
  }
  const ui = render(
    <ThemeProvider>
      <OfficeSessionProvider value={session}>
        <Harness />
      </OfficeSessionProvider>
    </ThemeProvider>,
  );
  return { ...ui, api, onSelect, onClose };
}

describe("Office search modal", () => {
  it("supports keyboard result navigation and dismisses the modal with Escape", async () => {
    const { onSelect } = mount();
    const input = screen.getByRole("textbox", { name: "Поиск по системе" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Палет" } });
    fireEvent.submit(input.closest("form")!);
    const item = await screen.findByRole("button", { name: /Палет \(00\)/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Результаты поиска" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Поиск по системе" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps focus in the modal when the submit button becomes disabled", async () => {
    mount();
    const input = screen.getByRole("textbox", { name: "Поиск по системе" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "Палет" } });
    const submit = screen.getByRole("button", { name: "Найти" });
    act(() => submit.focus());
    fireEvent.submit(input.closest("form")!);
    expect(document.activeElement).toBe(input);
    await screen.findByRole("button", { name: /Палет \(00\)/ });
  });

  it("ignores a slow scan after an outside click", async () => {
    let finish: (value: OfficeSearchResponse) => void = () => undefined;
    const search = vi.fn(
      () =>
        new Promise<OfficeSearchResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { onSelect } = mount("(00)146006820000000409", search);
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    await act(async () => finish(response));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Результаты поиска" })).toBeNull();
  });

  it.each(["success", "error"] as const)(
    "ignores a pending scan %s if a dialog opens meanwhile",
    async (outcome) => {
      let finish: () => void = () => undefined;
      const search = vi.fn(
        () =>
          new Promise<OfficeSearchResponse>((resolve, reject) => {
            finish = () =>
              outcome === "success" ? resolve(response) : reject(new Error("offline"));
          }),
      );
      const { onSelect } = mount("(00)146006820000000409", search);
      await waitFor(() => expect(search).toHaveBeenCalledOnce());
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      try {
        await act(async () => finish());
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.queryByRole("region", { name: "Результаты поиска" })).toBeNull();
      } finally {
        dialog.remove();
      }
    },
  );

  it("focuses the modal query and groups manual results without automatic navigation", async () => {
    const { api, onSelect } = mount();
    const input = screen.getByRole("textbox", { name: "Поиск по системе" });
    expect(screen.getByRole("dialog", { name: "Поиск по системе" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "Палет" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("region", { name: "Складские палеты" })).toBeTruthy();
    expect(api.searchOffice).toHaveBeenCalledWith(expect.any(String), {
      kind: "text",
      text: "Палет",
    });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Палет \(00\)/ }));
    expect(onSelect).toHaveBeenCalledWith(response.items[0]?.target);
  });

  it("opens a unique scan result, but not a truncated result", async () => {
    const first = mount("(00)146006820000000409");
    await waitFor(() => expect(first.onSelect).toHaveBeenCalledWith(response.items[0]?.target));
    first.unmount();
    const second = mount(
      "(00)146006820000000409",
      vi.fn(async () => ({ ...response, truncated: true })),
    );
    expect(
      await screen.findByText(
        "Найдено больше 50 результатов. Показаны первые 50. Уточните запрос.",
      ),
    ).toBeTruthy();
    expect(second.onSelect).not.toHaveBeenCalled();
  });

  it("discards a slow scan after the user edits the query", async () => {
    let finish: (value: OfficeSearchResponse) => void = () => undefined;
    const search = vi.fn(
      () =>
        new Promise<OfficeSearchResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { onSelect } = mount("(00)146006820000000409", search);
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск по системе" }), {
      target: { value: "другой" },
    });
    await act(async () => finish(response));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText(response.items[0]?.label ?? "")).toBeNull();
  });
});
