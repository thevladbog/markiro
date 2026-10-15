import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OrgProfile } from "../src/host/protocol.js";
import {
  createOfficeQueryClient,
  officeKeys,
  useOfficeInfiniteQuery,
  useOfficeMutation,
  useOfficeQuery,
} from "../src/office/office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "../src/office/office-session.js";
import { fakeOfficeSession } from "./support/office.js";

// A safety net for the offline test's `finally`: if an assertion throws
// before it runs, the online flag must not stay off for this file's later
// tests.
afterEach(() => onlineManager.setOnline(true));

const PROFILE: OrgProfile = {
  name: "ООО «Атолл»",
  inn: null,
  gln: "4600682000013",
  gs1Prefixes: [],
  timeZone: "Europe/Moscow",
  rev: 4,
};

function wrapperFor(session: OfficeSessionValue) {
  const client = createOfficeQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <OfficeSessionProvider value={session}>{children}</OfficeSessionProvider>
      </QueryClientProvider>
    );
  };
}

describe("useOfficeInfiniteQuery", () => {
  it("reads the first page without a cursor and the next with the one the page named", async () => {
    const session = fakeOfficeSession();
    const pages = [
      { items: ["a"], nextCursor: "c1" },
      { items: ["b"], nextCursor: null },
    ];
    const read = vi.fn(async (_cursor: string | null) => pages[read.mock.calls.length - 1]!);
    const { result } = renderHook(
      () =>
        useOfficeInfiniteQuery(
          ["office", "pages"],
          (_api, _token, cursor) => read(cursor),
          (page) => page.nextCursor,
        ),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(read).toHaveBeenLastCalledWith(null);
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(read).toHaveBeenLastCalledWith("c1");
    expect(result.current.data?.pages.map((page) => page.items)).toEqual([["a"], ["b"]]);
    expect(result.current.hasNextPage).toBe(false);
  });

  it("reads nothing while it is not enabled", async () => {
    const session = fakeOfficeSession();
    const read = vi.fn(async () => ({ nextCursor: null }));
    renderHook(
      () =>
        useOfficeInfiniteQuery(["office", "held"], read, (page) => page.nextCursor, {
          enabled: false,
        }),
      { wrapper: wrapperFor(session) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(read).not.toHaveBeenCalled();
  });
});

describe("useOfficeQuery", () => {
  it("reads through the session's call with its api and token", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(PROFILE);
    const call = vi.spyOn(session, "call");
    const { result } = renderHook(
      () => useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.data).toEqual(PROFILE));
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.api.getOrg).toHaveBeenCalledWith("office-session-token");
  });

  it("reads again at the interval it is given, and never without one", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(PROFILE);
    session.api.listUsers.mockResolvedValue([]);
    renderHook(
      () => ({
        once: useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
        polled: useOfficeQuery(officeKeys.users, (api, token) => api.listUsers(token), {
          refetchInterval: 20,
        }),
      }),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(session.api.listUsers.mock.calls.length).toBeGreaterThan(2));
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed read: the page explains it and offers a retry", async () => {
    const failure = new HostError({ kind: "api", code: "internal", status: 500, message: "boom" });
    const session = fakeOfficeSession();
    session.api.getOrg.mockRejectedValue(failure);
    const { result } = renderHook(
      () => useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(failure);
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("keeps reading and writing over IPC while the webview reports itself offline", async () => {
    // Calls go over IPC to the host, and the webview's online flag says
    // nothing about whether the host answers.
    onlineManager.setOnline(false);
    try {
      const session = fakeOfficeSession();
      session.api.getOrg.mockResolvedValue(PROFILE);
      session.api.updateOrg.mockResolvedValue({ ...PROFILE, rev: 5 });
      const { result } = renderHook(
        () => ({
          query: useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
          mutation: useOfficeMutation((api, token, expectedRev: number) =>
            api.updateOrg(token, {
              name: PROFILE.name,
              inn: null,
              gln: PROFILE.gln,
              gs1Prefixes: [],
              timeZone: PROFILE.timeZone,
              expectedRev,
            }),
          ),
        }),
        { wrapper: wrapperFor(session) },
      );
      await waitFor(() => expect(result.current.query.data).toEqual(PROFILE));
      expect(session.api.getOrg).toHaveBeenCalledWith("office-session-token");

      // A mutation must not stay paused offline either: without
      // `networkMode: "always"` in the mutations defaults, this hangs and
      // the test times out instead of resolving.
      await act(async () => {
        await expect(result.current.mutation.mutateAsync(4)).resolves.toMatchObject({ rev: 5 });
      });
      expect(session.api.updateOrg).toHaveBeenCalledWith(
        "office-session-token",
        expect.objectContaining({ expectedRev: 4 }),
      );
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe("useOfficeMutation", () => {
  it("writes through the session's call", async () => {
    const session = fakeOfficeSession();
    session.api.updateOrg.mockResolvedValue({ ...PROFILE, rev: 5 });
    const call = vi.spyOn(session, "call");
    const { result } = renderHook(
      () =>
        useOfficeMutation((api, token, expectedRev: number) =>
          api.updateOrg(token, {
            name: PROFILE.name,
            inn: null,
            gln: PROFILE.gln,
            gs1Prefixes: [],
            timeZone: PROFILE.timeZone,
            expectedRev,
          }),
        ),
      { wrapper: wrapperFor(session) },
    );
    await act(async () => {
      await expect(result.current.mutateAsync(4)).resolves.toMatchObject({ rev: 5 });
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.api.updateOrg).toHaveBeenCalledWith(
      "office-session-token",
      expect.objectContaining({ expectedRev: 4 }),
    );
  });

  it("forgets a write with `gcTime: 0` once reset, and keeps others for react-query's default", async () => {
    const session = fakeOfficeSession();
    const client = createOfficeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <OfficeSessionProvider value={session}>{children}</OfficeSessionProvider>
      </QueryClientProvider>
    );
    const write = (_api: unknown, _token: string, text: string) => Promise.resolve(text.length);
    const { result } = renderHook(
      () => ({
        secret: useOfficeMutation(write, { gcTime: 0 }),
        plain: useOfficeMutation(write),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.secret.mutateAsync("secret-text");
      await result.current.plain.mutateAsync("plain-text");
    });
    act(() => {
      result.current.secret.reset();
      result.current.plain.reset();
    });
    const held = () =>
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables);
    await waitFor(() => expect(held()).toEqual(["plain-text"]));
  });
});
