import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, type TableColumn } from "@markiro/ui";

import { hostWindow, windowRows } from "../src/office/paging/host-window.js";
import { PagedTable } from "../src/office/paging/PagedTable.js";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  readPageSize,
  writePageSize,
} from "../src/office/paging/page-size.js";
import { PaginationBar } from "../src/office/paging/PaginationBar.js";
import { chooseText } from "./support/select.js";

interface Row {
  id: string;
  name: string;
}

const COLUMNS: TableColumn<Row>[] = [{ key: "name", title: "Название" }];

function rowsOf(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    name: `Строка ${String(index + 1)}`,
  }));
}

function table(count: number, props: { tableId?: string; resetKey?: string } = {}) {
  return (
    <ThemeProvider defaultTheme="dark">
      <PagedTable
        tableId={props.tableId ?? "demo"}
        {...(props.resetKey === undefined ? {} : { resetKey: props.resetKey })}
        columns={COLUMNS}
        rows={rowsOf(count)}
        scrollLabel="Демо-таблица"
        pagerLabel="Страницы демо"
      />
    </ThemeProvider>
  );
}

function shown(): string[] {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent ?? "");
}

const pager = () => screen.getByRole("navigation", { name: "Страницы демо" });
const SIZE = "Строк на странице: Демо-таблица";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the page size kept per table", () => {
  it("offers 10, 25, 50 and 100, and opens on 10", () => {
    expect(PAGE_SIZES).toEqual([10, 25, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(10);
    expect(readPageSize("never-set")).toBe(10);
  });

  it("keeps a size under the table's own key, and reads a damaged value as the default", () => {
    writePageSize("first", 50);
    expect(readPageSize("first")).toBe(50);
    expect(readPageSize("second")).toBe(10);
    expect(localStorage.getItem("markiro.office.pageSize.first")).toBe("50");
    for (const damaged of ["7", "abc", "", "1e2", "100.5", "-10"]) {
      localStorage.setItem("markiro.office.pageSize.broken", damaged);
      expect(readPageSize("broken")).toBe(10);
    }
  });

  it("falls back to the default when the webview's storage refuses to read or to write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage off");
    });
    expect(readPageSize("any")).toBe(10);
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writePageSize("any", 25)).not.toThrow();
  });
});

describe("the host's pages cut into the office's pages", () => {
  it("finds the host pages a page of the office lies on", () => {
    // 10 and 25 and 50 per page divide the host's 50: one host page each.
    expect(hostWindow(1, 10, 50)).toEqual({ first: 1, last: 1, offset: 0 });
    expect(hostWindow(5, 10, 50)).toEqual({ first: 1, last: 1, offset: 40 });
    expect(hostWindow(6, 10, 50)).toEqual({ first: 2, last: 2, offset: 0 });
    expect(hostWindow(2, 25, 50)).toEqual({ first: 1, last: 1, offset: 25 });
    expect(hostWindow(2, 50, 50)).toEqual({ first: 2, last: 2, offset: 0 });
    // A hundred spans two host pages, from the first of a pair.
    expect(hostWindow(1, 100, 50)).toEqual({ first: 1, last: 2, offset: 0 });
    expect(hostWindow(3, 100, 50)).toEqual({ first: 5, last: 6, offset: 0 });
  });

  it("takes the rows from the host pages, from the offset, `size` of them or fewer at the end", () => {
    const one = hostWindow(2, 10, 50);
    expect(windowRows(one, 10, rowsOf(50), undefined).map((row) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 11)),
    );
    const two = hostWindow(1, 100, 50);
    expect(windowRows(two, 100, rowsOf(50), rowsOf(20))).toHaveLength(70);
    expect(windowRows(two, 100, rowsOf(50), rowsOf(50))).toHaveLength(100);
  });
});

describe("the pagination bar", () => {
  const bar = (props: Partial<Parameters<typeof PaginationBar>[0]> = {}) =>
    render(
      <ThemeProvider defaultTheme="dark">
        <PaginationBar
          label="Страницы демо"
          name="Демо-таблица"
          page={1}
          pageSize={10}
          shownRows={10}
          total={95}
          pageCount={10}
          hasNext
          onPage={() => undefined}
          onPageSize={() => undefined}
          {...props}
        />
      </ThemeProvider>,
    );

  it("shows nothing for ten rows or fewer: there is nothing to turn", () => {
    bar({ total: 10, pageCount: 1, hasNext: false });
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("says which rows of how many are shown, and which page of how many", () => {
    bar({ page: 3, shownRows: 10 });
    expect(screen.getByText("Показано 21–30 из 95")).toBeTruthy();
    expect(within(pager()).getByText("Страница 3 из 10")).toBeTruthy();
  });

  it("offers «в начало» and «в конец» only with many pages, and not on the page they would go to", () => {
    const { unmount } = bar({ pageCount: 4, total: 40 });
    expect(screen.queryByRole("button", { name: "Первая страница" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Последняя страница" })).toBeNull();
    unmount();
    bar({ page: 1 });
    expect(screen.getByRole("button", { name: "Первая страница" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Последняя страница" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("names its page-size choice by the table, and takes only the sizes offered", () => {
    const onPageSize = vi.fn();
    bar({ onPageSize });
    chooseText(SIZE, "50");
    expect(onPageSize).toHaveBeenCalledWith(50);
  });

  it("for a list of unknown length says there is more, and has no «в конец»", () => {
    bar({ total: null, pageCount: null, page: 5, shownRows: 10 });
    expect(screen.getByText("Показано 41–50, есть ещё")).toBeTruthy();
    expect(within(pager()).getByText("Страница 5")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Последняя страница" })).toBeNull();
    expect(screen.getByRole("button", { name: "Первая страница" })).toBeTruthy();
  });

  it("waits while a page is on its way", () => {
    bar({ busy: true });
    expect(within(pager()).getByRole("button", { name: "Вперёд" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});

describe("a table paged in the webview", () => {
  it("shows ten rows a page, the rows shown and the page, and goes forward and back", () => {
    render(table(25));
    expect(shown()).toHaveLength(10);
    expect(shown()[0]).toBe("Строка 1");
    expect(screen.getByText("Показано 1–10 из 25")).toBeTruthy();
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(shown()[0]).toBe("Строка 11");
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(shown()).toHaveLength(5);
    expect(screen.getByText("Показано 21–25 из 25")).toBeTruthy();
    expect(within(pager()).getByRole("button", { name: "Вперёд" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(within(pager()).getByRole("button", { name: "Назад" }));
    expect(shown()[0]).toBe("Строка 11");
  });

  it("has no pagination for ten rows, but keeps the table a named, focusable scroll region", () => {
    render(table(10));
    expect(screen.queryByRole("navigation", { name: "Страницы демо" })).toBeNull();
    const region = screen.getByRole("region", { name: "Демо-таблица" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("changes the size, goes back to the first page and keeps the size for this table only", () => {
    const { unmount } = render(table(60));
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    chooseText(SIZE, "25");
    expect(shown()).toHaveLength(25);
    expect(screen.getByText("Показано 1–25 из 60")).toBeTruthy();
    expect(within(pager()).getByText("Страница 1 из 3")).toBeTruthy();
    expect(localStorage.getItem("markiro.office.pageSize.demo")).toBe("25");
    unmount();
    // The size is the table's: it opens on 25 again, and another table opens on 10.
    render(table(60));
    expect(shown()).toHaveLength(25);
    cleanup();
    render(table(60, { tableId: "another" }));
    expect(shown()).toHaveLength(10);
  });

  it("goes back to the first page when its reset key changes, and not when it stays", () => {
    const { rerender } = render(table(60, { resetKey: "a" }));
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(shown()[0]).toBe("Строка 11");
    rerender(table(60, { resetKey: "a" }));
    expect(shown()[0]).toBe("Строка 11");
    rerender(table(60, { resetKey: "b" }));
    expect(shown()[0]).toBe("Строка 1");
  });

  it("shows the last page that is left when the rows get fewer under an open page", () => {
    const { rerender } = render(table(25));
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    fireEvent.click(within(pager()).getByRole("button", { name: "Вперёд" }));
    expect(shown()).toHaveLength(5);
    rerender(table(12));
    expect(shown().map((row) => row)).toEqual(["Строка 11", "Строка 12"]);
    expect(within(pager()).getByText("Страница 2 из 2")).toBeTruthy();
    rerender(table(8));
    expect(shown()).toHaveLength(8);
    expect(screen.queryByRole("navigation", { name: "Страницы демо" })).toBeNull();
  });

  it("takes the arrow keys as a scroll of its region, as the shared table does", () => {
    render(table(30));
    const region = screen.getByRole("region", { name: "Демо-таблица" });
    // jsdom has no layout: the region has no overflow to scroll, and the key is still taken.
    expect(fireEvent.keyDown(region, { key: "ArrowRight" })).toBe(false);
  });
});
