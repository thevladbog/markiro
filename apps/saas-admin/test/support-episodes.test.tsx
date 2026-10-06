import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  renderSaasApp,
  jsonResponse,
  ACCOUNTANT_ME,
  PLATFORM_ADMIN_ME,
  SUPPORT_ME,
} from "./render.js";

const id = "00000000-0000-4000-8000-000000000601";
const episode = {
  id,
  messages: [
    {
      id: "00000000-0000-4000-8000-000000000602",
      direction: "customer",
      text: "Помогите с маркировкой",
      occurredAt: "2026-10-06T10:00:00.000Z",
      delivery: "sent",
    },
  ],
  nextCursor: null,
  proposal: null,
  request: null,
  sync: { state: "healthy", lastSyncedAt: null, errorCode: null },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["declined", "pending"])(
  "lets the current writer issue a fresh proposal after %s",
  async (state) => {
    const proposal = {
      id: "00000000-0000-4000-8000-000000000604",
      revision: 1,
      title: "Old proposal",
      summary: "Old issue",
      noticeVersion: "support-transcript-v1",
      state,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
          return jsonResponse(200, { ...episode, proposal });
        if (url.endsWith("/proposals")) {
          const body = JSON.parse(String(init?.body));
          return jsonResponse(201, {
            ...proposal,
            id: "00000000-0000-4000-8000-000000000605",
            revision: 2,
            title: body.title,
            summary: body.summary,
            state: "pending",
          });
        }
        throw Error(url);
      }),
    );
    renderSaasApp({ initialEntry: `/support/${id}` });
    await screen.findByText("Old proposal");
    fireEvent.change(screen.getByRole("textbox", { name: "Заголовок обращения" }), {
      target: { value: "Fresh proposal" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Краткое описание" }), {
      target: { value: "Fresh summary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Предложить создание обращения" }));
    expect(await screen.findByRole("heading", { name: "Fresh proposal" })).toBeTruthy();
    expect(screen.queryByText("Old issue")).toBeNull();
  },
);

it("lets a billing reader open a private support episode and see its public messages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (url.endsWith("/api/platform/support-chat/episodes"))
        return jsonResponse(200, {
          items: [{ ...episode, messages: undefined, nextCursor: undefined }],
          nextCursor: null,
        });
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
        return jsonResponse(200, episode);
      throw Error(url);
    }),
  );
  renderSaasApp({ initialEntry: "/support" });
  fireEvent.click(await screen.findByRole("link", { name: "Вопрос" }));
  expect(await screen.findByText("Помогите с маркировкой")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Предложить создание обращения/ })).toBeTruthy();
});

it("requires operator review when historical consent notice is unknown", async () => {
  const broken = {
    ...episode,
    sync: { state: "error", lastSyncedAt: null, errorCode: "consent_notice_unknown" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
        return jsonResponse(200, broken);
      throw Error(url);
    }),
  );
  renderSaasApp({ initialEntry: `/support/${id}` });
  expect(await screen.findByText(/нет подтверждённого предупреждения/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Повторить синхронизацию/ })).toBeNull();
});

it("lets a billing writer schedule retry for a failed transcript sync", async () => {
  const broken = {
    ...episode,
    sync: { state: "error", lastSyncedAt: null, errorCode: "sync_failed" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
        return jsonResponse(200, broken);
      if (url.endsWith("/retry-sync"))
        return jsonResponse(200, {
          ...broken,
          sync: { state: "pending", lastSyncedAt: null, errorCode: null },
        });
      throw Error(url);
    }),
  );
  renderSaasApp({ initialEntry: `/support/${id}` });
  expect(await screen.findByText("Ошибка синхронизации истории")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Повторить синхронизацию/ }));
  await waitFor(() => expect(screen.getByText(/синхронизируется/)).toBeTruthy());
});

it("denies a current operator without billing.read before fetching support data", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/platform/me")) return jsonResponse(200, SUPPORT_ME);
    throw Error(`Unexpected support fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  renderSaasApp({ initialEntry: "/support" });
  expect(await screen.findByText("Нет доступа к чатам поддержки")).toBeTruthy();
  expect(fetcher.mock.calls.some(([input]) => String(input).includes("/support-chat/"))).toBe(
    false,
  );
});

it("proposes escalation from the operator panel and shows pending customer decision", async () => {
  const proposal = {
    id: "00000000-0000-4000-8000-000000000604",
    revision: 1,
    title: "Проверить код",
    summary: "Ошибка маркировки",
    noticeVersion: "support-transcript-v1",
    state: "pending",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`) && !init?.method)
        return jsonResponse(200, episode);
      if (url.endsWith("/proposals")) return jsonResponse(200, proposal);
      throw Error(url);
    }),
  );
  renderSaasApp({ initialEntry: `/support/${id}` });
  await screen.findByText("Помогите с маркировкой");
  fireEvent.change(screen.getByRole("textbox", { name: "Заголовок обращения" }), {
    target: { value: proposal.title },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Краткое описание" }), {
    target: { value: proposal.summary },
  });
  fireEvent.click(screen.getByRole("button", { name: "Предложить создание обращения" }));
  expect(await screen.findByText("Ожидает решения клиента")).toBeTruthy();
});

it("resets proposal draft and fences an old mutation when one operator changes episodes", async () => {
  const secondId = "00000000-0000-4000-8000-000000000611";
  let release: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`) && !init?.method)
        return jsonResponse(200, episode);
      if (url.endsWith(`/api/platform/support-chat/episodes/${secondId}`) && !init?.method)
        return jsonResponse(200, {
          ...episode,
          id: secondId,
          messages: [
            {
              ...episode.messages[0],
              id: "00000000-0000-4000-8000-000000000612",
              text: "Второй вопрос",
            },
          ],
        });
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}/proposals`))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      throw Error(url);
    }),
  );
  const app = renderSaasApp({ initialEntry: `/support/${id}` });
  await screen.findByText("Помогите с маркировкой");
  fireEvent.change(screen.getByRole("textbox", { name: "Заголовок обращения" }), {
    target: { value: "Старый заголовок" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Краткое описание" }), {
    target: { value: "Старое описание" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Предложить создание обращения" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => {
    await app.router.navigate(`/support/${secondId}`);
  });
  expect(await screen.findByText("Второй вопрос")).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "Заголовок обращения" }) as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByRole("textbox", { name: "Краткое описание" }) as HTMLTextAreaElement).value,
  ).toBe("");
  await act(async () => {
    release!(
      jsonResponse(200, {
        id: "00000000-0000-4000-8000-000000000613",
        revision: 1,
        title: "Старый заголовок",
        summary: "Старое описание",
        noticeVersion: "support-transcript-v1",
        state: "pending",
      }),
    );
  });
  expect(screen.queryByText("Старый заголовок")).toBeNull();
});

it("shows an older-page failure and removes history after a 403", async () => {
  let status = 503;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (url.includes("cursor=older")) return jsonResponse(status, { code: "UNAVAILABLE" });
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
        return jsonResponse(200, { ...episode, nextCursor: "older" });
      throw Error(url);
    }),
  );
  renderSaasApp({ initialEntry: `/support/${id}` });
  await screen.findByText("Помогите с маркировкой");
  fireEvent.click(screen.getByRole("button", { name: "Ранние сообщения" }));
  expect(await screen.findByText(/Не удалось загрузить ранние сообщения/)).toBeTruthy();
  status = 403;
  fireEvent.click(screen.getByRole("button", { name: /Повторить загрузку/ }));
  expect(await screen.findByText(/Нет доступа к чатам поддержки/)).toBeTruthy();
  expect(screen.queryByText("Помогите с маркировкой")).toBeNull();
});

it("ignores a late older page from a different episode", async () => {
  const secondId = "00000000-0000-4000-8000-000000000621";
  let release: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, ACCOUNTANT_ME);
      if (url.includes("cursor=older"))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
        return jsonResponse(200, { ...episode, nextCursor: "older" });
      if (url.endsWith(`/api/platform/support-chat/episodes/${secondId}`))
        return jsonResponse(200, {
          ...episode,
          id: secondId,
          messages: [{ ...episode.messages[0], id: secondId, text: "Второй вопрос" }],
        });
      throw Error(url);
    }),
  );
  const app = renderSaasApp({ initialEntry: `/support/${id}` });
  await screen.findByText("Помогите с маркировкой");
  fireEvent.click(screen.getByRole("button", { name: "Ранние сообщения" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => {
    await app.router.navigate(`/support/${secondId}`);
  });
  expect(await screen.findByText("Второй вопрос")).toBeTruthy();
  await act(async () => {
    release!(
      jsonResponse(200, {
        ...episode,
        messages: [
          {
            ...episode.messages[0],
            id: "00000000-0000-4000-8000-000000000622",
            text: "Чужая старая история",
          },
        ],
      }),
    );
  });
  expect(screen.queryByText("Чужая старая история")).toBeNull();
  expect(screen.getByText("Второй вопрос")).toBeTruthy();
});
