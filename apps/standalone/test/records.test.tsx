import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  activeFirstByName,
  useChangeList,
  useStoreRecord,
  withRecord,
  type ArchivableRecord,
} from "../src/office/records.js";

const KEY = ["office", "records"] as const;

function row(id: string, name: string, archived = false): ArchivableRecord {
  return { id, name, archived };
}

/**
 * Frozen inputs: a function that changed its argument would throw instead of
 * passing unnoticed. The records are frozen too.
 */
function frozen<T extends object>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function names(records: readonly ArchivableRecord[]): string[] {
  return records.map((each) => each.name);
}

describe("withRecord", () => {
  it("puts the record in place of the one with its id, which keeps its position", () => {
    const first = row("a", "Первая");
    const second = row("b", "Вторая");
    const third = row("c", "Третья");
    const edited = row("b", "Вторая (правка)");
    const result = withRecord([first, second, third], edited);
    expect(result).toStrictEqual([first, edited, third]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(edited);
    expect(result[2]).toBe(third);
  });

  it("adds a record whose id is new at the end", () => {
    const first = row("a", "Первая");
    const second = row("b", "Вторая");
    const added = row("c", "Третья");
    const result = withRecord([first, second], added);
    expect(result).toStrictEqual([first, second, added]);
    expect(result[2]).toBe(added);
  });

  it("changes neither the array nor the record it is given", () => {
    const records = frozen([row("a", "Первая"), row("b", "Вторая")]);
    const before = structuredClone(records);
    const edited = Object.freeze(row("b", "Вторая (правка)"));
    const added = Object.freeze(row("c", "Третья"));

    const replaced = withRecord(records, edited);
    const appended = withRecord(records, added);

    expect(replaced).not.toBe(records);
    expect(appended).not.toBe(records);
    expect(records).toStrictEqual(before);
    expect(edited).toStrictEqual(row("b", "Вторая (правка)"));
    expect(added).toStrictEqual(row("c", "Третья"));
  });
});

describe("activeFirstByName", () => {
  it("lists active records before archived ones, each group by name", () => {
    const result = activeFirstByName([
      row("1", "Б", true),
      row("2", "Я"),
      row("3", "А", true),
      row("4", "В"),
    ]);
    expect(result.map((each) => `${each.name}:${each.archived ? "архив" : "действует"}`)).toEqual([
      "В:действует",
      "Я:действует",
      "А:архив",
      "Б:архив",
    ]);
  });

  it("orders numbers by value, not by digit: «Линия 2» before «Линия 10»", () => {
    const result = activeFirstByName([
      row("1", "Линия 10"),
      row("2", "Линия 2"),
      row("3", "Линия 1"),
      row("4", "Линия 20"),
    ]);
    expect(names(result)).toEqual(["Линия 1", "Линия 2", "Линия 10", "Линия 20"]);
  });

  it("orders records with equal names by id, whatever order they came in", () => {
    const low = row("a", "Линия");
    const high = row("b", "Линия");
    expect(activeFirstByName([high, low])).toStrictEqual([low, high]);
    expect(activeFirstByName([low, high])).toStrictEqual([low, high]);
    const oldLow = row("a", "Линия", true);
    const oldHigh = row("b", "Линия", true);
    expect(activeFirstByName([oldHigh, oldLow])).toStrictEqual([oldLow, oldHigh]);
  });

  it("returns a new array and leaves the one it is given as it was", () => {
    const records = frozen([row("1", "Я", true), row("2", "Б"), row("3", "А")]);
    const before = structuredClone(records);
    const result = activeFirstByName(records);
    expect(result).not.toBe(records);
    expect(names(result)).toEqual(["А", "Б", "Я"]);
    expect(records).toStrictEqual(before);
  });
});

/** A query client with `cached` stored under `KEY` when given, and the wrapper that provides it. */
function cachedClient(cached?: ArchivableRecord[]) {
  const client = new QueryClient();
  if (cached) client.setQueryData(KEY, cached);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, invalidate, Wrapper };
}

describe("useChangeList", () => {
  function setup(cached?: ArchivableRecord[]) {
    const { client, invalidate, Wrapper } = cachedClient(cached);
    const { result } = renderHook(() => useChangeList<ArchivableRecord>(KEY), { wrapper: Wrapper });
    return { client, invalidate, change: result.current };
  }

  it("applies the change to the cached list and stores what it returns", () => {
    const first = row("a", "Первая");
    const second = row("b", "Вторая");
    const added = row("c", "Третья");
    const { client, invalidate, change } = setup([first, second]);
    const seen: ArchivableRecord[][] = [];
    change((list) => {
      seen.push(list);
      return [...list.filter((each) => each.id !== "a"), added];
    });
    // The change gets the list that was cached, once; the result replaces it.
    expect(seen).toStrictEqual([[first, second]]);
    expect(client.getQueryData<ArchivableRecord[]>(KEY)).toStrictEqual([second, added]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reads the list again, and stores nothing, when no list is loaded", () => {
    const { client, invalidate, change } = setup();
    const apply = vi.fn((list: ArchivableRecord[]) => list);
    change(apply);
    // Nothing to change: a list of one row would be shown as the whole list.
    expect(apply).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(client.getQueryData(KEY)).toBeUndefined();
  });
});

describe("useStoreRecord", () => {
  function setup(cached?: ArchivableRecord[]) {
    const { client, invalidate, Wrapper } = cachedClient(cached);
    const { result } = renderHook(() => useStoreRecord<ArchivableRecord>(KEY), {
      wrapper: Wrapper,
    });
    return { client, invalidate, store: result.current };
  }

  it("replaces the record in the cached list, in place", () => {
    const first = row("a", "Первая");
    const edited = row("b", "Вторая (правка)");
    const third = row("c", "Третья");
    const { client, invalidate, store } = setup([first, row("b", "Вторая"), third]);
    store(edited);
    expect(client.getQueryData<ArchivableRecord[]>(KEY)).toStrictEqual([first, edited, third]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("adds a record the cached list does not have", () => {
    const first = row("a", "Первая");
    const added = row("b", "Вторая");
    const { client, invalidate, store } = setup([first]);
    store(added);
    expect(client.getQueryData<ArchivableRecord[]>(KEY)).toStrictEqual([first, added]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reads the list again, rather than caching one row, when no list is loaded", () => {
    const { client, invalidate, store } = setup();
    store(row("a", "Первая"));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(client.getQueryData(KEY)).toBeUndefined();
  });
});
