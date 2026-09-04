import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useChannelJournal,
  type ChannelState,
  type JournalPageResponse,
  type JournalOutcomeFilter,
  type JournalSessionDto,
} from "../src/pages/integrations/api.js";
import { JournalList } from "../src/pages/integrations/JournalList.js";
import i18n from "../src/i18n/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function session(
  id: string,
  startedAt: string,
  outcome: string | null,
  overrides: Partial<JournalSessionDto> = {},
): JournalSessionDto {
  return {
    id,
    startedAt,
    finishedAt: new Date(new Date(startedAt).getTime() + 65_000).toISOString(),
    outcome,
    summary: null,
    eventCount: 0,
    eventsTruncated: false,
    events: [],
    ...overrides,
  };
}

function journalPage(
  sessions: JournalSessionDto[],
  pageInfo: JournalPageResponse["pageInfo"] = {
    page: 1,
    pageSize: 20,
    totalItems: sessions.length,
    totalPages: sessions.length === 0 ? 0 : 1,
  },
): JournalPageResponse {
  return { timeZone: "Asia/Irkutsk", sessions, pageInfo };
}

function renderJournal(
  responseFor: (url: string) => JournalPageResponse = () => journalPage([]),
  channelState: ChannelState = "working",
) {
  const fetchMock = vi.fn(async (url: string) => jsonResponse(responseFor(url)));
  return renderJournalWithFetch(fetchMock, channelState);
}

function renderJournalWithFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  channelState: ChannelState = "working",
) {
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <JournalList type="commerceml" channelState={channelState} />
    </QueryClientProvider>,
  );
  return { ...view, fetchMock, queryClient };
}

function Probe({ outcome }: { outcome: JournalOutcomeFilter }) {
  const { data } = useChannelJournal("commerceml", {
    page: 2,
    pageSize: 20,
    outcome,
    direction: "local",
    period: "7d",
  });
  return <p>{data ? `${data.pageInfo.page}:${data.pageInfo.totalItems}` : "loading"}</p>;
}

describe("integration journal client", () => {
  it("builds a dated paginated request and separates filtered cache entries", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-02T12:00:00.000Z").getTime());
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        timeZone: "Europe/Moscow",
        sessions: [],
        pageInfo: { page: 2, pageSize: 20, totalItems: 31, totalPages: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <Probe outcome="error" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("2:31")).toBeDefined();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/integrations/commerceml/journal?page=2&pageSize=20&outcome=error&direction=local&from=2026-08-26T12%3A00%3A00.000Z&to=2026-09-02T12%3A00%3A00.000Z",
      expect.any(Object),
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe outcome="warn" />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("outcome=warn"),
      expect.any(Object),
    );
  });
});

describe("integration journal interface", () => {
  it("keeps a newer successful session above an older error and groups in tenant time", async () => {
    await i18n.changeLanguage("ru");
    const newer = session("newer-ok", "2026-09-02T16:30:00.000Z", "ok");
    const older = session("older-error", "2026-09-01T16:30:00.000Z", "error");
    renderJournal(() => journalPage([newer, older]));

    const rows = await screen.findAllByTestId("journal-session");
    expect(rows.map((row) => row.getAttribute("data-session-id"))).toEqual([
      "newer-ok",
      "older-error",
    ]);
    expect(screen.getByText("3 сентября 2026 г.")).toBeDefined();
    expect(screen.getByText("2 сентября 2026 г.")).toBeDefined();
    expect(screen.getByText("Найдено сеансов: 2")).toBeDefined();
  });

  it("changes page, then applies an outcome tab and resets to page one", async () => {
    renderJournal((_url) =>
      journalPage([session("one", "2026-09-02T12:00:00.000Z", "ok")], {
        page: 1,
        pageSize: 20,
        totalItems: 41,
        totalPages: 3,
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Следующая" }));
    await vi.waitFor(() => expect(screen.getByRole("tab", { name: "Ошибки" })).toBeDefined());
    await userEvent.click(screen.getByRole("tab", { name: "Ошибки" }));

    const requestedUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      String(url),
    );
    expect(requestedUrls.some((url) => url.includes("page=2"))).toBe(true);
    expect(requestedUrls.at(-1)).toContain("page=1&pageSize=20&outcome=error");
  });

  it("uses a real disclosure button and preserves exact protocol text", async () => {
    const row = session("failed", "2026-09-02T12:00:00.000Z", "error", {
      eventCount: 27,
      eventsTruncated: true,
      events: [
        {
          at: "2026-09-02T12:00:03.000Z",
          direction: "in",
          outcome: "error",
          message: "Файл не разобран",
          details: { raw: "failure\nCommerceML: unexpected token at 12" },
        },
      ],
    });
    renderJournal(() => journalPage([row]));

    const toggle = await screen.findByRole("button", { name: /файл не разобран/i });
    expect(toggle.tagName).toBe("BUTTON");
    await userEvent.click(toggle);
    expect(await screen.findByText("Показано событий: 1 из 27")).toBeDefined();
    await userEvent.click(screen.getByText("Ответ в протокол обмена"));
    expect(screen.getByText(/CommerceML: unexpected token at 12/)).toBeDefined();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a True API refusal inside its single pass without repeating the summary", async () => {
    const summary = "Статусы кодов Честного Знака обновлены не полностью";
    const row = session("chz-refresh", "2026-09-04T11:50:24.000Z", "warn", {
      finishedAt: "2026-09-04T11:50:24.000Z",
      eventCount: 1,
      events: [
        {
          at: "2026-09-04T11:50:24.000Z",
          direction: "out",
          outcome: "warn",
          message: summary,
          details: {
            warnings: [
              {
                kind: "rejected",
                productGroupCode: 15,
                code: "400",
                message: "В запросе указана недопустимая товарная группа",
                codes: 12,
              },
            ],
          },
        },
      ],
    });
    renderJournal(() => journalPage([row]));

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(summary, "i") }));

    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.getByText("В запросе указана недопустимая товарная группа")).toBeDefined();
    expect(screen.getByText(/группа 15/i)).toBeDefined();
  });

  it("shows useful fallback details for token and empty-message True API warnings", async () => {
    const summary = "Статусы кодов Честного Знака обновлены не полностью";
    const row = session("chz-warning-fallbacks", "2026-09-04T11:50:24.000Z", "warn", {
      eventCount: 1,
      events: [
        {
          at: "2026-09-04T11:50:24.000Z",
          direction: "out",
          outcome: "warn",
          message: summary,
          details: {
            warnings: [
              {
                kind: "unauthorized",
                productGroupCode: 8,
                tokenStatus: "unauthorized",
              },
              {
                kind: "rejected",
                productGroupCode: 15,
                code: "403",
                message: "",
                codes: 4,
              },
            ],
          },
        },
      ],
    });
    renderJournal(() => journalPage([row]));

    await userEvent.click(await screen.findByRole("button", { name: new RegExp(summary, "i") }));

    expect(screen.getByText("Токен True API недействителен, запрошено обновление")).toBeDefined();
    expect(screen.getByText("Честный Знак отклонил запрос статусов")).toBeDefined();
    expect(screen.getByText(/HTTP 403/)).toBeDefined();
  });

  it("turns a current error notice into the Errors filter", async () => {
    renderJournal(() => journalPage([]), "error");

    await userEvent.click(await screen.findByRole("button", { name: "Показать ошибки" }));
    const requestedUrls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      String(url),
    );
    expect(requestedUrls.at(-1)).toContain("outcome=error");
  });

  it("applies period and direction controls to the request", async () => {
    renderJournal();

    await screen.findByText("Обменов ещё не было");
    await userEvent.selectOptions(screen.getByLabelText("Период"), "90d");
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Период")).not.toHaveProperty("disabled", true),
    );
    await userEvent.selectOptions(screen.getByLabelText("Направление"), "out");

    await vi.waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(String(calls.at(-1)?.[0])).toContain("direction=out");
    });
    const url = new URL(
      String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]),
      "http://local",
    );
    const from = new Date(url.searchParams.get("from")!);
    const to = new Date(url.searchParams.get("to")!);
    expect(to.getTime() - from.getTime()).toBe(90 * 86_400_000);
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("distinguishes a filtered empty page and resets it", async () => {
    renderJournal();

    await userEvent.click(await screen.findByRole("tab", { name: "Ошибки" }));
    expect(await screen.findByText("По этим фильтрам ничего не найдено")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(await screen.findByText("Обменов ещё не было")).toBeDefined();
  });

  it("offers retry after an initial load failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "failed" }, 500))
      .mockResolvedValueOnce(jsonResponse(journalPage([])));
    renderJournalWithFetch(fetchMock);

    expect(await screen.findByText("Не удалось загрузить журнал.")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Обменов ещё не было")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns to the last valid page when a refreshed page disappears", async () => {
    renderJournal((url) => {
      const page = new URL(url, "http://local").searchParams.get("page");
      return page === "2"
        ? journalPage([], { page: 2, pageSize: 20, totalItems: 1, totalPages: 1 })
        : journalPage([session("one", "2026-09-02T12:00:00.000Z", "ok")], {
            page: 1,
            pageSize: 20,
            totalItems: 41,
            totalPages: 3,
          });
    });

    await userEvent.click(await screen.findByRole("button", { name: "Следующая" }));
    await vi.waitFor(() => {
      const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
        String(url),
      );
      expect(urls.some((url) => url.includes("page=2"))).toBe(true);
      expect(urls.at(-1)).toContain("page=1");
    });
  });

  it("keeps stale rows visible when loading another page fails", async () => {
    const firstPage = journalPage([session("stable", "2026-09-02T12:00:00.000Z", "ok")], {
      page: 1,
      pageSize: 20,
      totalItems: 21,
      totalPages: 2,
    });
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("page=2") ? jsonResponse({ message: "failed" }, 500) : jsonResponse(firstPage),
    );
    renderJournalWithFetch(fetchMock);

    await userEvent.click(await screen.findByRole("button", { name: "Следующая" }));
    expect(await screen.findByText(/не удалось обновить журнал/i)).toBeDefined();
    expect(screen.getByTestId("journal-session").getAttribute("data-session-id")).toBe("stable");
  });

  it("disables paging while the requested page is still loading", async () => {
    const firstPage = journalPage([session("stable", "2026-09-02T12:00:00.000Z", "ok")], {
      page: 1,
      pageSize: 20,
      totalItems: 21,
      totalPages: 2,
    });
    let resolveSecond!: (response: Response) => void;
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.fn((url: string) =>
      url.includes("page=2") ? secondPage : Promise.resolve(jsonResponse(firstPage)),
    );
    renderJournalWithFetch(fetchMock);

    const next = await screen.findByRole("button", { name: "Следующая" });
    await userEvent.click(next);
    await vi.waitFor(() => expect(next).toHaveProperty("disabled", true));
    await userEvent.click(next);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecond(
      jsonResponse(
        journalPage([session("second", "2026-09-01T12:00:00.000Z", "ok")], {
          page: 2,
          pageSize: 20,
          totalItems: 21,
          totalPages: 2,
        }),
      ),
    );
    expect(await screen.findByText("Страница 2 из 2")).toBeDefined();
  });
});
