import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { AuthClientProvider, type AuthClientLike } from "../src/auth/client.js";
import { AccessProvider } from "../src/access/context.js";
import { SupportChatPage } from "../src/pages/support/SupportChatPage.js";

const episodeId = "00000000-0000-4000-8000-000000000501";
const proposalId = "00000000-0000-4000-8000-000000000502";
const sync = { state: "healthy", lastSyncedAt: null, errorCode: null };
const episode = {
  id: episodeId,
  messages: [
    {
      id: "00000000-0000-4000-8000-000000000503",
      direction: "operator",
      text: "Ответ поддержки",
      occurredAt: "2026-10-06T10:00:00.000Z",
      delivery: "sent",
    },
  ],
  nextCursor: null,
  proposal: null,
  request: null,
  sync,
};
const episodeSummary = {
  id: episode.id,
  proposal: episode.proposal,
  request: episode.request,
  sync: episode.sync,
};
const auth = {
  useSession: () => ({
    data: {
      user: { id: "user-a", email: "a@example.invalid" },
      session: { activeOrganizationId: "tenant-a" },
    },
    isPending: false,
    error: null,
  }),
  useListOrganizations: () => ({
    data: [{ id: "tenant-a", name: "A", slug: "a" }],
    isPending: false,
    error: null,
  }),
} as AuthClientLike;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function renderPage(capabilities: string[] = [], authClient = auth) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider client={client}>
        <AuthClientProvider client={authClient}>
          <AccessProvider value={{ capabilities } as never}>
            <MemoryRouter>
              <SupportChatPage />
            </MemoryRouter>
          </AccessProvider>
        </AuthClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
  const result = render(tree());
  return { ...result, client, refresh: () => result.rerender(tree()) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["existing", "empty"])(
  "waits for the initial %s list before creating a question and releases busy after creation",
  async (kind) => {
    let releaseList: ((value: Response) => void) | undefined;
    let releaseCreate: ((value: Response) => void) | undefined;
    const created = {
      ...episode,
      id: proposalId,
      messages: [{ ...episode.messages[0]!, text: "Created question reply" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/support-chat/episodes")) {
          if (init?.method === "POST")
            return new Promise<Response>((resolve) => {
              releaseCreate = resolve;
            });
          return new Promise<Response>((resolve) => {
            releaseList = resolve;
          });
        }
        return response(url.endsWith(proposalId) ? created : episode);
      }),
    );
    renderPage();
    await waitFor(() => expect(releaseList).toBeTypeOf("function"));
    const create = screen.getByRole("button", { name: "Новый вопрос" });
    expect(create.hasAttribute("disabled")).toBe(true);
    fireEvent.click(create);
    expect(releaseCreate).toBeUndefined();
    await act(async () =>
      releaseList!(
        response({
          items: kind === "existing" ? [episodeSummary] : [],
          nextCursor: null,
        }),
      ),
    );
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(releaseCreate).toBeTypeOf("function"));
    expect(create.hasAttribute("disabled")).toBe(true);
    await act(async () => releaseCreate!(response(created)));
    await screen.findByText("Created question reply");
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next message" } });
    expect(screen.getByRole("button", { name: "Отправить" }).hasAttribute("disabled")).toBe(false);
  },
);

it("keeps creation unavailable after an initial list failure until a successful retry", async () => {
  let releaseRetry: ((value: Response) => void) | undefined;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes")) {
        if (++reads === 1) return response({ message: "Unavailable" }, 503);
        return new Promise<Response>((resolve) => {
          releaseRetry = resolve;
        });
      }
      return response(episode);
    }),
  );
  renderPage();
  const retry = await screen.findByRole("button", { name: "Повторить" });
  const create = screen.getByRole("button", { name: "Новый вопрос" });
  expect(create.hasAttribute("disabled")).toBe(true);
  fireEvent.click(retry);
  await waitFor(() => expect(releaseRetry).toBeTypeOf("function"));
  expect(create.hasAttribute("disabled")).toBe(true);
  await act(async () => releaseRetry!(response({ items: [episodeSummary], nextCursor: null })));
  await screen.findByText("Ответ поддержки");
  expect(create.hasAttribute("disabled")).toBe(false);
});

it("reaches episode 51 after reload and retains loaded and newly created episodes", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    ...episode,
    id: `00000000-0000-4000-8000-${String(600 + i).padStart(12, "0")}`,
    proposal: {
      id: proposalId,
      revision: 1,
      title: `Question ${i + 1}`,
      summary: "Done",
      noticeVersion: "support-transcript-v1",
      state: "declined",
    },
    messages: [{ ...episode.messages[0]!, text: `Reply ${i + 1}` }],
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname.endsWith("/support-chat/episodes")) {
        if (init?.method === "POST")
          return response({ ...rows[50], id: episodeId, proposal: null });
        const items = parsed.searchParams.has("cursor") ? rows.slice(50) : rows.slice(0, 50);
        return response({
          items: items.map(({ messages: _messages, nextCursor: _cursor, ...row }) => row),
          nextCursor: parsed.searchParams.has("cursor") ? null : rows[49]!.id,
        });
      }
      return response(
        rows.find((row) => parsed.pathname.endsWith(row.id)) ?? { ...episode, messages: [] },
      );
    }),
  );
  const first = renderPage();
  await screen.findByText("Reply 1");
  fireEvent.click(screen.getByRole("button", { name: "Показать ещё вопросы" }));
  fireEvent.click(await screen.findByRole("button", { name: "Question 51" }));
  await screen.findByText("Reply 51");
  fireEvent.click(screen.getByRole("button", { name: "Новый вопрос" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Вопрос" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Question 51" }));
  await screen.findByText("Reply 51");
  fireEvent.click(screen.getByRole("button", { name: "Question 1" }));
  await screen.findByText("Reply 1");
  first.unmount();
  renderPage();
  await screen.findByText("Reply 1");
  fireEvent.click(screen.getByRole("button", { name: "Показать ещё вопросы" }));
  fireEvent.click(await screen.findByRole("button", { name: "Question 51" }));
  await screen.findByText("Reply 51");
});

it.each(["success", "failure"])(
  "keeps B draft and busy ownership after a held A send %s",
  async (outcome) => {
    const second = {
      ...episode,
      id: "00000000-0000-4000-8000-000000000599",
      request: { id: proposalId, number: "BR-B", status: "new" },
      messages: [],
    };
    let releaseA: ((value: Response) => void) | undefined;
    let releaseB: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/support-chat/episodes"))
          return response({
            items: [episode, second].map(
              ({ messages: _messages, nextCursor: _cursor, ...row }) => row,
            ),
            nextCursor: null,
          });
        if (init?.method === "POST")
          return new Promise<Response>((resolve) => {
            if (url.includes(episodeId)) releaseA = resolve;
            else releaseB = resolve;
          });
        return response(url.endsWith(episodeId) ? episode : second);
      }),
    );
    renderPage();
    await screen.findByText("Ответ поддержки");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft A" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(releaseA).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "BR-B" }));
    await screen.findByText(/Обращение BR-B/);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Draft B" } });
    expect(screen.getByRole("button", { name: "Отправить" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(releaseB).toBeTypeOf("function"));
    await act(async () =>
      releaseA!(
        outcome === "success"
          ? response({ ...episode.messages[0], direction: "customer", text: "Draft A" })
          : response({ message: "Unavailable" }, 503),
      ),
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Draft B");
    expect(screen.getByRole("button", { name: "Отправить" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/Сообщение не подтверждено/)).toBeNull();
    await act(async () =>
      releaseB!(response({ ...episode.messages[0], direction: "customer", text: "Draft B" })),
    );
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""),
    );
  },
);

it.each([false, true])(
  "does not clear the next draft after held send completion, return to A=%s",
  async (returnToA) => {
    const second = {
      ...episode,
      id: "00000000-0000-4000-8000-000000000599",
      request: { id: proposalId, number: "BR-B", status: "new" },
      messages: [],
    };
    let release: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/support-chat/episodes"))
          return response({
            items: [episode, second].map(
              ({ messages: _messages, nextCursor: _cursor, ...row }) => row,
            ),
            nextCursor: null,
          });
        if (init?.method === "POST")
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return response(url.endsWith(episodeId) ? episode : second);
      }),
    );
    renderPage();
    await screen.findByText("Ответ поддержки");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Old draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "BR-B" }));
    await screen.findByText(/Обращение BR-B/);
    if (returnToA) {
      fireEvent.click(screen.getByRole("button", { name: "Вопрос" }));
      await screen.findByText("Ответ поддержки");
    }
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New draft" } });
    await act(async () =>
      release!(response({ ...episode.messages[0], direction: "customer", text: "Old draft" })),
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("New draft");
  },
);

it("shows cached unlinked outage feedback and clears it on retry", async () => {
  let recovered = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      return response({
        ...episode,
        sync: recovered ? sync : { ...sync, state: "error", errorCode: "sync_failed" },
      });
    }),
  );
  renderPage();
  await screen.findByText("Ответ поддержки");
  expect(screen.getByRole("alert").textContent).toMatch(/связи с поддержкой/i);
  recovered = true;
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText("Ответ поддержки")).toBeTruthy();
});

it.each(["create", "decision"])(
  "ignores stale %s completion after switching episodes",
  async (kind) => {
    const pending = {
      ...episode,
      proposal: {
        id: proposalId,
        revision: 1,
        title: "Question A",
        summary: "Proposal A",
        state: "pending",
        noticeVersion: "support-transcript-v1",
      },
    };
    const second = {
      ...episode,
      id: "00000000-0000-4000-8000-000000000599",
      request: { id: proposalId, number: "BR-B", status: "new" },
      messages: [],
    };
    let release: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST")
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        if (url.endsWith("/support-chat/episodes"))
          return response({
            items: [pending, second].map(
              ({ messages: _messages, nextCursor: _cursor, ...row }) => row,
            ),
            nextCursor: null,
          });
        return response(url.endsWith(episodeId) ? pending : second);
      }),
    );
    renderPage();
    await screen.findByText("Proposal A");
    fireEvent.click(
      screen.getByRole("button", {
        name: kind === "create" ? "Новый вопрос" : "Подтвердить перенос",
      }),
    );
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "BR-B" }));
    await screen.findByText(/Обращение BR-B/);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B stays selected" } });
    await act(async () =>
      release!(response({ ...episode, id: kind === "create" ? proposalId : episodeId })),
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("B stays selected");
    expect(screen.getByRole("button", { name: "BR-B" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Отправить" }).hasAttribute("disabled")).toBe(false);
  },
);

it.each(["send", "create", "decision"])(
  "does not restore private cache after denial during %s",
  async (kind) => {
    const pending = {
      ...episode,
      proposal: {
        id: proposalId,
        revision: 1,
        title: "Question A",
        summary: "Proposal A",
        state: "pending",
        noticeVersion: "support-transcript-v1",
      },
    };
    let release: ((value: Response) => void) | undefined;
    let revoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST")
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        if (revoked) return response({ message: "Forbidden" }, 403);
        if (url.endsWith("/support-chat/episodes"))
          return response({
            items: [{ ...pending, messages: undefined, nextCursor: undefined }],
            nextCursor: null,
          });
        return response(pending);
      }),
    );
    const page = renderPage();
    await screen.findByText("Proposal A");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Private draft" } });
    fireEvent.click(
      screen.getByRole("button", {
        name:
          kind === "create"
            ? "Новый вопрос"
            : kind === "send"
              ? "Отправить"
              : "Подтвердить перенос",
      }),
    );
    await waitFor(() => expect(release).toBeTypeOf("function"));
    revoked = true;
    await act(async () => {
      await page.client.invalidateQueries({ queryKey: ["support", "tenant-a", "user-a"] });
    });
    await screen.findByText(/Доступ к переписке утрачен/);
    await act(async () =>
      release!(
        response(
          kind === "send"
            ? { ...episode.messages[0], direction: "customer", text: "Private draft" }
            : pending,
        ),
      ),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Ответ поддержки")).toBeNull();
    expect(
      page.client
        .getQueriesData({ queryKey: ["support", "tenant-a", "user-a"] })
        .every(([, value]) => value === undefined),
    ).toBe(true);
  },
);

function historyMessages(start: number, count: number) {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return {
      ...episode.messages[0]!,
      id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
      text: `History ${index}`,
      occurredAt: new Date(Date.UTC(2026, 9, 6, 10, 0, index)).toISOString(),
    };
  });
}

async function historyScene(exhaust = true) {
  const state = {
    rows: historyMessages(0, 65),
    tenant: "tenant-a",
    reads: [] as Array<string | null>,
    beforeRead: undefined as ((cursor: string | null) => Promise<Response | void>) | undefined,
  };
  const mutableAuth = {
    ...auth,
    useSession: () => ({
      data: { user: { id: "user-a" }, session: { activeOrganizationId: state.tenant } },
      isPending: false,
      error: null,
    }),
  } as AuthClientLike;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items:
            state.tenant === "tenant-a"
              ? [{ ...episode, messages: undefined, nextCursor: undefined }]
              : [],
          nextCursor: null,
        });
      const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
      state.reads.push(cursor);
      const intercepted = await state.beforeRead?.(cursor);
      if (intercepted) return intercepted;
      const index = cursor
        ? state.rows.findIndex((message) => message.id === cursor)
        : state.rows.length;
      if (index < 0) throw Error(`Unknown history cursor ${cursor}`);
      const start = Math.max(0, index - 50);
      return response({
        ...episode,
        messages: state.rows.slice(start, index),
        nextCursor: start > 0 ? state.rows[start]!.id : null,
      });
    }),
  );
  const page = renderPage([], mutableAuth);
  await screen.findByText("History 64");
  if (exhaust) {
    fireEvent.click(screen.getByRole("button", { name: "Показать ранние сообщения" }));
    await screen.findByText("History 0");
    expect(screen.queryByRole("button", { name: "Показать ранние сообщения" })).toBeNull();
  }
  const poll = async () => {
    const before = state.reads.length;
    await act(async () => {
      await page.client.refetchQueries({ queryKey: ["support", "tenant-a", "user-a", "episode"] });
    });
    expect(state.reads.length - before).toBeLessThanOrEqual(2);
  };
  return { state, page, poll };
}

it("recovers an eighty-message burst after the manual history cursor is exhausted", async () => {
  const { state, poll } = await historyScene();
  state.rows.push(...historyMessages(65, 80));
  await poll();
  await poll();
  await poll();
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145));
  expect(screen.getByText("History 65")).toBeTruthy();
  expect(screen.getAllByText("History 0")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Показать ранние сообщения" })).toBeNull();
});

it("recovers only the opened range while preserving manual access to unread older history", async () => {
  const { state, poll } = await historyScene(false);
  state.rows.push(...historyMessages(65, 80));
  await poll();
  await poll();
  await poll();
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(130));
  expect(screen.queryByText("History 0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Показать ранние сообщения" }));
  await screen.findByText("History 0");
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145));
});

it("rescans overlapping partial backfill and discovers later inserts older than every cached timestamp", async () => {
  const { state, poll } = await historyScene();
  state.rows.push(...historyMessages(105, 40));
  await poll();
  state.rows.splice(65, 0, ...historyMessages(65, 40));
  await poll();
  await poll();
  await poll();
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145));
  state.rows.unshift({
    ...historyMessages(200, 1)[0]!,
    text: "Late older import",
    occurredAt: "2026-10-05T10:00:00.000Z",
  });
  for (let i = 0; i < 4; i++) await poll();
  expect(await screen.findByText("Late older import")).toBeTruthy();
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145));
});

it("retries a failed gap page without losing the unfinished range", async () => {
  const { state, poll } = await historyScene();
  state.rows.push(...historyMessages(65, 80));
  let fail = true;
  state.beforeRead = async (cursor) => {
    if (cursor && fail) {
      fail = false;
      throw Error("lost gap response");
    }
  };
  await poll();
  expect(await screen.findByText(/Нет связи с поддержкой/)).toBeTruthy();
  await poll();
  await poll();
  await poll();
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145));
});

it("clears conversation and composer when automatic gap recovery is denied", async () => {
  const { state, poll } = await historyScene();
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Private draft" },
  });
  state.rows.push(...historyMessages(65, 80));
  state.beforeRead = async (cursor) =>
    cursor ? response({ message: "Forbidden" }, 403) : undefined;
  await poll();
  expect(await screen.findByText(/Доступ к переписке утрачен/)).toBeTruthy();
  expect(screen.queryByText("History 0")).toBeNull();
  expect(screen.queryByRole("textbox", { name: /сообщение/i })).toBeNull();
});

it("discards a late gap response after the organization changes", async () => {
  const { state, page } = await historyScene();
  state.rows.push(...historyMessages(65, 80));
  let release: ((value: Response) => void) | undefined;
  state.beforeRead = async (cursor) =>
    cursor
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : undefined;
  let pending: Promise<void> | undefined;
  act(() => {
    pending = page.client.refetchQueries({
      queryKey: ["support", "tenant-a", "user-a", "episode"],
    });
  });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  state.tenant = "tenant-b";
  page.refresh();
  await act(async () => {
    release!(response({ ...episode, messages: historyMessages(65, 50) }));
    await pending;
  });
  expect(await screen.findByText(/Здесь пока нет переписки/)).toBeTruthy();
  expect(screen.queryByText("History 65")).toBeNull();
  expect(
    page.client.getQueryData(["support", "tenant-a", "user-a", "episode", episodeId]),
  ).toBeUndefined();
});

it("retains a manual older read completed while a gap page is in flight", async () => {
  const { state, page } = await historyScene(false);
  state.rows.push(...historyMessages(65, 80));
  let release: ((value: Response) => void) | undefined;
  state.beforeRead = async (cursor) =>
    cursor === state.rows[95]!.id
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : undefined;
  let pending: Promise<void> | undefined;
  act(() => {
    pending = page.client.refetchQueries({
      queryKey: ["support", "tenant-a", "user-a", "episode"],
    });
  });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Показать ранние сообщения" }));
  await screen.findByText("History 0");
  await act(async () => {
    release!(
      response({ ...episode, messages: state.rows.slice(45, 95), nextCursor: state.rows[45]!.id }),
    );
    await pending;
  });
  await waitFor(() => expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145));
  expect(screen.getAllByText("History 0")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Показать ранние сообщения" })).toBeNull();
});

it("resumes an unfinished sweep from the same cursor after a later page fails", async () => {
  const { state, poll } = await historyScene();
  state.rows.push(...historyMessages(65, 80));
  await poll();
  const cursor = state.rows[45]!.id;
  state.rows.unshift({
    ...historyMessages(200, 1)[0]!,
    text: "Late older import",
    occurredAt: "2026-10-05T10:00:00.000Z",
  });
  let failed = false;
  state.beforeRead = async (value) => {
    if (value === cursor && !failed) {
      failed = true;
      throw Error("lost resumed page");
    }
  };
  await poll();
  expect(await screen.findByText(/Нет связи с поддержкой/)).toBeTruthy();
  await poll();
  expect(await screen.findByText("Late older import")).toBeTruthy();
  expect(state.reads.slice(-4)).toEqual([null, cursor, null, cursor]);
  expect(screen.getAllByText(/^History \d+$/)).toHaveLength(145);
});

it("keeps an unclaimed pending draft and retries the same message intent", async () => {
  const keys: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`)) return response(episode);
      if (url.endsWith("/messages")) {
        const body = JSON.parse(String(init?.body));
        keys.push(body.idempotencyKey);
        return response({
          id: "00000000-0000-4000-8000-000000000509",
          direction: "customer",
          text: body.text,
          occurredAt: "2026-10-06T10:01:00.000Z",
          delivery: keys.length === 1 ? "pending" : "sent",
        });
      }
      throw Error(url);
    }),
  );
  renderPage();
  await screen.findByText("Ответ поддержки");
  const composer = screen.getByRole("textbox", { name: /сообщение/i });
  fireEvent.change(composer, { target: { value: "Queued question" } });
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  await screen.findByText("Queued question", { selector: "p" });
  expect((composer as HTMLTextAreaElement).value).toBe("Queued question");
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

it("shows operator reply and lets a member send a new private message without a billing link", async () => {
  const linked = {
    ...episode,
    request: { id: "00000000-0000-4000-8000-000000000504", number: "BR-000001", status: "new" },
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/support-chat/episodes") && !init?.method)
      return response({
        items: [{ ...linked, messages: undefined, nextCursor: undefined }],
        nextCursor: null,
      });
    if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method)
      return response(linked);
    if (url.endsWith("/messages"))
      return response({
        id: crypto.randomUUID(),
        direction: "customer",
        text: "Вопрос",
        occurredAt: "2026-10-06T10:01:00.000Z",
        delivery: "sent",
      });
    throw Error(String(url));
  });
  vi.stubGlobal("fetch", fetcher);
  renderPage();
  expect(await screen.findByText("Ответ поддержки")).toBeTruthy();
  expect(screen.getByText(/Обращение BR-000001/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Вопрос" },
  });
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Переписка" })).getByText("Вопрос"),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("link", { name: /BR-/ })).toBeNull();
});

it("shows the exact shared consent notice and confirms the linked request", async () => {
  let accepted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const pending = {
        ...episode,
        proposal: {
          id: proposalId,
          revision: 1,
          title: "Нужна помощь",
          summary: "Не решено",
          noticeVersion: "support-transcript-v1",
          state: "pending",
        },
      };
      if (url.endsWith("/support-chat/episodes") && !init?.method)
        return response({
          items: [{ ...pending, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method)
        return response(pending);
      if (url.endsWith("/decision")) {
        accepted = true;
        return response({
          ...pending,
          proposal: { ...pending.proposal, state: "accepted" },
          request: {
            id: "00000000-0000-4000-8000-000000000504",
            number: "BR-000001",
            status: "new",
          },
        });
      }
      throw Error(String(url));
    }),
  );
  renderPage(["billing.read"]);
  expect(await screen.findByText(/Переписка по этому вопросу будет добавлена/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Подтвердить перенос/ }));
  await waitFor(() => expect(accepted).toBe(true));
  expect(await screen.findByRole("link", { name: "BR-000001" })).toBeTruthy();
});

it("never renders a late response from the previous organization", async () => {
  let currentTenant = "tenant-a";
  let releaseA: ((value: Response) => void) | undefined;
  const mutableAuth = {
    ...auth,
    useSession: () => ({
      data: {
        user: { id: "user-a", email: "a@example.invalid" },
        session: { activeOrganizationId: currentTenant },
      },
      isPending: false,
      error: null,
    }),
  } as AuthClientLike;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes")) {
        if (currentTenant === "tenant-a")
          return new Promise<Response>((resolve) => {
            releaseA = resolve;
          });
        return response({ items: [], nextCursor: null });
      }
      throw Error(String(url));
    }),
  );
  const page = renderPage([], mutableAuth);
  await waitFor(() => expect(releaseA).toBeTypeOf("function"));
  currentTenant = "tenant-b";
  page.refresh();
  await act(async () => {
    releaseA!(
      response({
        items: [{ ...episode, messages: undefined, nextCursor: undefined }],
        nextCursor: null,
      }),
    );
  });
  expect(await screen.findByText(/Здесь пока нет переписки/)).toBeTruthy();
  expect(screen.queryByText("Ответ поддержки")).toBeNull();
});

it("clears a visible conversation and composer after membership denial", async () => {
  let denied = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (denied) return response({ message: "Forbidden" }, 403);
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      return response(episode);
    }),
  );
  const page = renderPage();
  expect(await screen.findByText("Ответ поддержки")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Текст до отзыва" },
  });
  denied = true;
  await act(async () => {
    await page.client.invalidateQueries({ queryKey: ["support", "tenant-a", "user-a"] });
  });
  expect(await screen.findByText(/Доступ к переписке утрачен/)).toBeTruthy();
  expect(screen.queryByText("Ответ поддержки")).toBeNull();
  expect(screen.queryByRole("textbox", { name: /сообщение/i })).toBeNull();
});

it("reuses one send intent after a lost response and changes the key for edited text", async () => {
  const posts: Array<{ text: string; idempotencyKey: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/support-chat/episodes") && !init?.method)
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method)
        return response(episode);
      if (url.endsWith("/messages")) {
        const body = JSON.parse(String(init?.body)) as { text: string; idempotencyKey: string };
        posts.push(body);
        if (posts.length === 1) throw Error("lost response");
        return response({
          id: crypto.randomUUID(),
          direction: "customer",
          text: body.text,
          occurredAt: "2026-10-06T10:01:00.000Z",
          delivery: "sent",
        });
      }
      throw Error(String(url));
    }),
  );
  renderPage();
  await screen.findByText("Ответ поддержки");
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Первый текст" },
  });
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(screen.getByText("Первый текст")).toBeTruthy());
  expect(posts[0]?.idempotencyKey).toBe(posts[1]?.idempotencyKey);
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Другой текст" },
  });
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  await waitFor(() => expect(posts).toHaveLength(3));
  expect(posts[2]?.idempotencyKey).not.toBe(posts[1]?.idempotencyKey);
});

it("does not render a late send after logout", async () => {
  let loggedIn = true;
  let release: ((value: Response) => void) | undefined;
  const mutableAuth = {
    ...auth,
    useSession: () => ({
      data: loggedIn
        ? {
            user: { id: "user-a", email: "a@example.invalid" },
            session: { activeOrganizationId: "tenant-a" },
          }
        : null,
      isPending: false,
      error: null,
    }),
  } as AuthClientLike;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/support-chat/episodes") && !init?.method)
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method)
        return response(episode);
      if (url.endsWith("/messages"))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      throw Error(String(url));
    }),
  );
  const page = renderPage([], mutableAuth);
  await screen.findByText("Ответ поддержки");
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Секретный текст" },
  });
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  loggedIn = false;
  page.refresh();
  await act(async () => {
    release!(
      response({
        id: crypto.randomUUID(),
        direction: "customer",
        text: "Секретный текст",
        occurredAt: "2026-10-06T10:01:00.000Z",
        delivery: "sent",
      }),
    );
  });
  expect(screen.queryByText("Секретный текст")).toBeNull();
  expect(screen.queryByText("Ответ поддержки")).toBeNull();
});

it("polls an open conversation every five seconds and pauses in a hidden tab", async () => {
  let reads = 0;
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("visible");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`)) {
        reads += 1;
        return response(episode);
      }
      throw Error(String(url));
    }),
  );
  renderPage();
  await screen.findByText("Ответ поддержки");
  vi.useFakeTimers();
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const initial = reads;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(reads).toBeGreaterThan(initial);
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenReads = reads;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(reads).toBe(hiddenReads);
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(reads).toBeGreaterThan(hiddenReads);
});

it("declining an escalation leaves no request link and sends the shared notice version", async () => {
  const proposal = {
    id: proposalId,
    revision: 3,
    title: "Диагностика",
    summary: "Нужна проверка",
    noticeVersion: "support-transcript-v1",
    state: "pending",
  };
  let decisionBody: Record<string, unknown> | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const pending = { ...episode, proposal };
      if (url.endsWith("/support-chat/episodes") && !init?.method)
        return response({
          items: [{ ...pending, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method)
        return response(pending);
      if (url.endsWith("/decision")) {
        decisionBody = JSON.parse(String(init?.body));
        return response({ ...pending, proposal: { ...proposal, state: "declined" } });
      }
      throw Error(String(url));
    }),
  );
  renderPage();
  await screen.findByText(/Переписка по этому вопросу будет добавлена/);
  fireEvent.click(screen.getByRole("button", { name: "Отказаться" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Отказаться" })).toBeNull());
  expect(decisionBody).toMatchObject({
    decision: "decline",
    revision: 3,
    noticeVersion: "support-transcript-v1",
    noticeLocale: "ru",
  });
  expect(screen.queryByRole("link", { name: /BR-/ })).toBeNull();
});

it("refreshes a proposal after a stale revision conflict before asking again", async () => {
  const first = {
    id: proposalId,
    revision: 1,
    title: "Старый заголовок",
    summary: "Старое описание",
    noticeVersion: "support-transcript-v1",
    state: "pending",
  };
  const second = { ...first, revision: 2, title: "Новый заголовок", summary: "Новое описание" };
  let detailReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/support-chat/episodes") && !init?.method)
        return response({
          items: [{ ...episode, proposal: first, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method) {
        detailReads += 1;
        return response({ ...episode, proposal: detailReads > 1 ? second : first });
      }
      if (url.endsWith("/decision")) return response({ message: "stale proposal" }, 409);
      throw Error(String(url));
    }),
  );
  renderPage();
  await screen.findByText("Старое описание");
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить перенос" }));
  expect(await screen.findByText("Новое описание")).toBeTruthy();
  expect(screen.queryByText("Старое описание")).toBeNull();
});

it("clears an older-page conversation and composer when membership is revoked", async () => {
  const paged = { ...episode, nextCursor: "older" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items: [{ ...paged, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.includes("cursor=older")) return response({ message: "Forbidden" }, 403);
      if (url.endsWith(`/support-chat/episodes/${episodeId}`)) return response(paged);
      throw Error(url);
    }),
  );
  renderPage();
  await screen.findByText("Ответ поддержки");
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Черновик" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Показать ранние сообщения" }));
  expect(await screen.findByText(/Доступ к переписке утрачен/)).toBeTruthy();
  expect(screen.queryByText("Ответ поддержки")).toBeNull();
  expect(screen.queryByRole("textbox", { name: /сообщение/i })).toBeNull();
});

it("retains older messages after a five-second refresh adds an operator reply", async () => {
  let latestReads = 0;
  const older = {
    id: "00000000-0000-4000-8000-000000000511",
    direction: "customer",
    text: "Старый вопрос",
    occurredAt: "2026-10-06T09:00:00.000Z",
    delivery: "sent",
  };
  const newReply = {
    id: "00000000-0000-4000-8000-000000000512",
    direction: "operator",
    text: "Новый ответ",
    occurredAt: "2026-10-06T11:00:00.000Z",
    delivery: "sent",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/support-chat/episodes"))
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.includes("cursor=older"))
        return response({ ...episode, messages: [older], nextCursor: null });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`)) {
        latestReads += 1;
        return response({
          ...episode,
          messages: latestReads > 1 ? [...episode.messages, newReply] : episode.messages,
          nextCursor: "older",
        });
      }
      throw Error(url);
    }),
  );
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("visible");
  renderPage();
  await screen.findByText("Ответ поддержки");
  fireEvent.click(screen.getByRole("button", { name: "Показать ранние сообщения" }));
  await screen.findByText("Старый вопрос");
  vi.useFakeTimers();
  visibility.mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.getByText("Новый ответ")).toBeTruthy();
  expect(screen.getByText("Старый вопрос")).toBeTruthy();
  expect(screen.getAllByText("Ответ поддержки")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Показать ранние сообщения" })).toBeNull();
});

it("removes the stale retry warning after a failed draft is edited", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/support-chat/episodes") && !init?.method)
        return response({
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/support-chat/episodes/${episodeId}`) && !init?.method)
        return response(episode);
      if (url.endsWith("/messages")) throw Error("connection dropped");
      throw Error(url);
    }),
  );
  renderPage();
  await screen.findByText("Ответ поддержки");
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Первый текст" },
  });
  fireEvent.click(screen.getByRole("button", { name: /отправить/i }));
  expect(await screen.findByText(/Сообщение не подтверждено/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: /сообщение/i }), {
    target: { value: "Новый текст" },
  });
  expect(screen.queryByText(/Повтор использует тот же запрос/)).toBeNull();
  expect(screen.getByRole("button", { name: /отправить/i }).hasAttribute("disabled")).toBe(false);
});
