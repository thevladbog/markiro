import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { UsClientError } from "../src/us/client.js";
import { createRequestFence } from "../src/us/requests/async-ownership.js";
import {
  deferred,
  renderRequests,
  requestDetail,
  requestSummary,
  requestsFixture,
} from "./us-requests-fixtures.js";
import { profile } from "./us-plans-fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const b = "a0000000-0000-4000-8000-000000000002";

it.each(["en-US", "es-US"])(
  "recovers a transient session lookup explicitly in %s without stranding authorized reads or guessing an actor",
  async (locale) => {
    const client = requestsFixture();
    const session = deferred<Awaited<ReturnType<typeof client.session>>>();
    const retry = deferred<Awaited<ReturnType<typeof client.session>>>();
    const list = deferred<Awaited<ReturnType<typeof client.requests.list>>>();
    const card = deferred<ReturnType<typeof requestDetail>>();
    vi.mocked(client.session)
      .mockReturnValueOnce(session.promise)
      .mockReturnValueOnce(retry.promise);
    vi.mocked(client.requests.list).mockReturnValue(list.promise);
    vi.mocked(client.requests.get).mockReturnValue(card.promise);
    const { container, props } = renderRequests(
      { client, entry: { requestId: requestSummary().id } },
      locale,
    );
    await act(async () => session.reject(new UsClientError("unavailable")));
    const retryLabel =
      locale === "en-US" ? "Retry session lookup" : "Reintentar consulta de sesión";
    const retryButton = await screen.findByRole("button", { name: retryLabel });
    expect(
      container
        .querySelector("[data-session-actor-ready]")
        ?.getAttribute("data-session-actor-ready"),
    ).toBe("false");
    expect(client.session).toHaveBeenCalledOnce();
    await act(async () => {
      list.resolve({ items: [requestSummary()], limit: 25, offset: 0, hasMore: false });
      card.resolve(requestDetail());
    });
    expect(await screen.findByText("Synthetic Requester")).toBeTruthy();
    expect(
      screen.queryByText(locale === "en-US" ? "Loading requests…" : "Cargando solicitudes…"),
    ).toBeNull();
    expect(
      screen.queryByText(
        locale === "en-US" ? "Loading saved request…" : "Cargando la solicitud guardada…",
      ),
    ).toBeNull();
    expect(vi.mocked(client.requests.list).mock.calls[0]?.[1]?.aborted).toBe(false);
    await userEvent.click(retryButton);
    expect(client.session).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: retryLabel }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      container
        .querySelector("[data-session-actor-ready]")
        ?.getAttribute("data-session-actor-ready"),
    ).toBe("false");
    await act(async () =>
      retry.resolve({
        user: {
          id: "verified-actor",
          name: "Synthetic actor",
          email: "actor@example.test",
          twoFactorEnabled: true,
        },
        activeOrganizationId: "tenant",
      }),
    );
    expect(
      container
        .querySelector("[data-session-actor-ready]")
        ?.getAttribute("data-session-actor-ready"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: retryLabel })).toBeNull();
    expect(screen.getByText("Synthetic Requester")).toBeTruthy();
    expect(props.onForbidden).not.toHaveBeenCalled();
    expect(props.onSessionLost).not.toHaveBeenCalled();
  },
);

it("never commits an older selection response", () => {
  const fence = createRequestFence();
  const first = fence.issue("request-a:1");
  const second = fence.issue("request-b:1");
  expect(fence.owns(first)).toBe(false);
  expect(fence.owns(second)).toBe(true);
  fence.invalidate();
  expect(fence.owns(second)).toBe(false);
});

it("reads one summary page without detail enrichment and exposes only saved summary facts", async () => {
  const { props } = renderRequests();
  const table = await screen.findByRole("table");
  expect(within(table).getByRole("button", { name: "REQ-1" })).toBeTruthy();
  expect(within(table).queryByText("Synthetic Requester")).toBeNull();
  expect(props.client.requests.list).toHaveBeenCalledWith(
    { limit: "25", offset: "0" },
    expect.any(AbortSignal),
  );
  expect(props.client.requests.get).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "New request" })).toBeNull();
  expect(screen.getByText("Local development — not operational evidence")).toBeTruthy();
});

it("uses server order and hasMore, resets pagination when exact filters change", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.list).mockResolvedValue({
    items: [requestSummary({ id: b, requestNumber: "REQ-B" }), requestSummary()],
    limit: 25,
    offset: 0,
    hasMore: true,
  });
  renderRequests({ client });
  const table = await screen.findByRole("table");
  expect(
    within(table)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["REQ-B", "REQ-1"]);
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(client.requests.list).toHaveBeenLastCalledWith(
      { limit: "25", offset: "25" },
      expect.any(AbortSignal),
    ),
  );
  fireEvent.change(screen.getByLabelText("Exact request number"), { target: { value: "REQ-B" } });
  fireEvent.change(screen.getByLabelText("Lifecycle"), { target: { value: "closed" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(client.requests.list).toHaveBeenLastCalledWith(
      { limit: "25", offset: "0", requestNumber: "REQ-B", status: "closed" },
      expect.any(AbortSignal),
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() =>
    expect(client.requests.list).toHaveBeenLastCalledWith(
      { limit: "25", offset: "0" },
      expect.any(AbortSignal),
    ),
  );
});

it("distinguishes empty from no match and preserves labelled last-success on failed refresh", async () => {
  const client = requestsFixture();
  renderRequests({ client });
  await screen.findByRole("table");
  vi.mocked(client.requests.list).mockRejectedValue(new UsClientError("unavailable"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh server state" }));
  expect(
    await screen.findByText("Last successful list — deadlines may be out of date"),
  ).toBeTruthy();
  expect((screen.getByRole("button", { name: "REQ-1" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(client.requests.list).mockResolvedValue({
    items: [],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh server state" }));
  await screen.findByText("No requests in this page.");
  fireEvent.change(screen.getByLabelText("Exact request number"), { target: { value: "missing" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  expect(await screen.findByText("No requests match these filters.")).toBeTruthy();
});

it.each(["resolve", "reject"] as const)(
  "discards deferred old card %s after a new selection",
  async (outcome) => {
    const client = requestsFixture();
    const old = deferred<ReturnType<typeof requestDetail>>();
    vi.mocked(client.requests.list).mockResolvedValue({
      items: [requestSummary(), requestSummary({ id: b, requestNumber: "REQ-B" })],
      limit: 25,
      offset: 0,
      hasMore: false,
    });
    vi.mocked(client.requests.get).mockImplementation((id) =>
      id === b
        ? Promise.resolve(
            requestDetail({ id: b, requestNumber: "REQ-B", requesterName: "Current requester" }),
          )
        : old.promise,
    );
    renderRequests({ client });
    await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
    await userEvent.click(screen.getByRole("button", { name: "REQ-B" }));
    await screen.findByText("Current requester");
    await act(async () => {
      if (outcome === "resolve") old.resolve(requestDetail());
      else old.reject(new UsClientError("forbidden"));
    });
    expect(screen.queryByText("Synthetic Requester")).toBeNull();
    expect(
      screen.queryByText("Request access was rejected. Refresh access before continuing."),
    ).toBeNull();
  },
);

it.each(["resolve", "reject"] as const)("discards deferred filtered page %s", async (outcome) => {
  const client = requestsFixture();
  const old = deferred<Awaited<ReturnType<typeof client.requests.list>>>();
  vi.mocked(client.requests.list)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({
      items: [requestSummary({ id: b, requestNumber: "REQ-B" })],
      limit: 25,
      offset: 0,
      hasMore: false,
    });
  renderRequests({ client });
  fireEvent.change(screen.getByLabelText("Exact request number"), { target: { value: "REQ-B" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  await screen.findByRole("button", { name: "REQ-B" });
  await act(async () => {
    if (outcome === "resolve")
      old.resolve({ items: [requestSummary()], limit: 25, offset: 0, hasMore: false });
    else old.reject(new UsClientError("forbidden"));
  });
  expect(screen.queryByRole("button", { name: "REQ-1" })).toBeNull();
  expect(
    screen.queryByText("Request access was rejected. Refresh access before continuing."),
  ).toBeNull();
});

it("shows not-found card and four keyboard reachable tabs without auditor mutation controls", async () => {
  const client = requestsFixture();
  renderRequests({ client });
  await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
  const tab = await screen.findByRole("tab", { name: "Requester and timing" });
  tab.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Scope" })).toBe(document.activeElement);
  expect(screen.getAllByRole("tab")).toHaveLength(4);
  expect(
    screen.queryByRole("button", { name: /Edit request|Close request|Prepare|Validate/ }),
  ).toBeNull();
  vi.mocked(client.requests.get).mockRejectedValue(new UsClientError("us_request_not_found"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  expect(await screen.findByText("This request is no longer available.")).toBeTruthy();
  expect(screen.queryByText("Synthetic Requester")).toBeNull();
});

it("stops all lanes and signals session loss only once", async () => {
  const client = requestsFixture();
  const list = deferred<Awaited<ReturnType<typeof client.requests.list>>>();
  const detail = deferred<ReturnType<typeof requestDetail>>();
  vi.mocked(client.requests.list).mockReturnValue(list.promise);
  vi.mocked(client.requests.get).mockReturnValue(detail.promise);
  const { props } = renderRequests({ client, entry: { requestId: requestSummary().id } });
  await act(async () => {
    detail.reject(new UsClientError("session_required"));
    list.reject(new UsClientError("session_required"));
  });
  expect(props.onSessionLost).toHaveBeenCalledOnce();
  expect(screen.queryByRole("table")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Refresh server state" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("clears rejected card even if READ stays granted, and failed refresh blocks actions", async () => {
  const client = requestsFixture();
  const onForbidden = vi.fn(async () => {
    throw new Error("refresh unavailable");
  });
  renderRequests({ client, onForbidden });
  await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
  await screen.findByText("Synthetic Requester");
  vi.mocked(client.requests.get).mockRejectedValue(new UsClientError("forbidden"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  await waitFor(() => expect(onForbidden).toHaveBeenCalledOnce());
  expect(screen.queryByText("Synthetic Requester")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Refresh request" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("clears a rejected summary lane and waits for explicit refresh when READ remains", async () => {
  const client = requestsFixture();
  const { props } = renderRequests({ client });
  await screen.findByRole("table");
  vi.mocked(client.requests.list).mockRejectedValue(new UsClientError("forbidden"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh server state" }));
  await waitFor(() => expect(props.onForbidden).toHaveBeenCalledOnce());
  expect(screen.queryByRole("table")).toBeNull();
  expect(client.requests.list).toHaveBeenCalledTimes(2);
  vi.mocked(client.requests.list).mockResolvedValue({
    items: [requestSummary()],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh server state" }));
  expect(await screen.findByRole("button", { name: "REQ-1" })).toBeTruthy();
});

it("preserves authorized detail when only QA/export access is removed", async () => {
  const { rerenderRequests } = renderRequests({
    canManageQa: true,
    canExport: true,
    entry: { requestId: requestSummary().id },
  });
  await screen.findByText("Synthetic Requester");
  rerenderRequests({ canManageQa: false, canExport: false });
  expect(screen.getByText("Synthetic Requester")).toBeTruthy();
});

it.each(["read", "profile", "tenant"])(
  "clears projections after %s change and ignores outstanding responses",
  async (change) => {
    const client = requestsFixture();
    const old = deferred<ReturnType<typeof requestDetail>>();
    vi.mocked(client.requests.get).mockReturnValue(old.promise);
    const { rerenderRequests } = renderRequests({
      client,
      entry: { requestId: requestSummary().id },
    });
    rerenderRequests(
      change === "read"
        ? { canRead: false }
        : change === "profile"
          ? { profile: { ...profile, code: "US_GENERIC_LOT_TRACEABILITY", timeZone: "UTC" } }
          : { organizationId: "other" },
    );
    await act(async () => old.resolve(requestDetail()));
    expect(screen.queryByText("Synthetic Requester")).toBeNull();
  },
);

it("disposes all pending reads and late failure callbacks on unmount", async () => {
  const client = requestsFixture();
  const list = deferred<Awaited<ReturnType<typeof client.requests.list>>>();
  const session = deferred<Awaited<ReturnType<typeof client.session>>>();
  const card = deferred<ReturnType<typeof requestDetail>>();
  vi.mocked(client.requests.list).mockReturnValue(list.promise);
  vi.mocked(client.session).mockReturnValue(session.promise);
  vi.mocked(client.requests.get).mockReturnValue(card.promise);
  const { unmount, props } = renderRequests({ client, entry: { requestId: requestSummary().id } });
  unmount();
  expect(vi.mocked(client.requests.list).mock.calls[0]?.[1]?.aborted).toBe(true);
  expect(vi.mocked(client.requests.get).mock.calls[0]?.[1]?.aborted).toBe(true);
  await act(async () => {
    list.reject(new UsClientError("forbidden"));
    session.reject(new UsClientError("session_required"));
    card.reject(new UsClientError("forbidden"));
  });
  expect(props.onForbidden).not.toHaveBeenCalled();
  expect(props.onSessionLost).not.toHaveBeenCalled();
});

it("updates the selected deadline at most once a minute and disposes countdown timers", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T23:00:00.000Z"));
  try {
    const { unmount } = renderRequests({ entry: { requestId: requestSummary().id } });
    await act(async () => {
      await Promise.resolve();
    });
    const announcement = document.querySelector('[aria-live="polite"]');
    expect(announcement?.textContent).toContain("1h 0m");
    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(announcement?.textContent).toContain("1h 0m");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(announcement?.textContent).toContain("0h 59m");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not repeatedly retry a forbidden session when READ remains granted", async () => {
  const client = requestsFixture();
  const refresh = deferred<void>();
  vi.mocked(client.session).mockRejectedValue(new UsClientError("forbidden"));
  const { props } = renderRequests({ client, onForbidden: vi.fn(() => refresh.promise) });
  await waitFor(() => expect(props.onForbidden).toHaveBeenCalled());
  await act(async () => refresh.resolve());
  expect(client.session).toHaveBeenCalledOnce();
});

it("retains captured request/run entry and rejects a late session from the previous tenant", async () => {
  const client = requestsFixture();
  const session = deferred<Awaited<ReturnType<typeof client.session>>>();
  vi.mocked(client.session)
    .mockReturnValueOnce(session.promise)
    .mockResolvedValue({
      user: {
        id: "other-actor",
        name: "Synthetic actor",
        email: "actor@example.test",
        twoFactorEnabled: true,
      },
      activeOrganizationId: "other",
    });
  const runId = "b0000000-0000-4000-8000-000000000002";
  const { rerenderRequests, container, props } = renderRequests({
    client,
    entry: { requestId: requestSummary().id, runId },
  });
  await screen.findByText("Synthetic Requester");
  expect(container.querySelector("[data-selected-run]")?.getAttribute("data-selected-run")).toBe(
    runId,
  );
  rerenderRequests({ organizationId: "other", entry: {} });
  await act(async () => session.reject(new UsClientError("session_required")));
  expect(props.onSessionLost).not.toHaveBeenCalled();
  expect(screen.queryByText("Synthetic Requester")).toBeNull();
});
