import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n/index.js";
import {
  replacementKeys,
  type PrepareAttempt,
  type CancelAttempt,
} from "../src/pages/tenants/replacement-state.js";
import { DeviceReplacementPanel } from "../src/pages/tenants/DeviceReplacementPanel.js";
import { pool, SOURCE, preparation, preview, response } from "./device-replacement-fixtures.js";
const authRefetch = vi.hoisted(() => vi.fn());
vi.mock("../src/auth/client.js", () => ({
  useAuthClient: () => ({ useSession: () => ({ refetch: authRefetch }) }),
}));
const randomUUID = vi.fn();
let serial = 0;
let bodies: Array<{ url: string; body: Record<string, unknown> }>;
let saved = false;
let cancelled = false;
let canPrepare = true;
let fail:
  | ((url: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined)
  | undefined;
function setup(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
  canWrite = true,
  sourcePool = pool,
) {
  return {
    client,
    ...render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ThemeProvider defaultTheme="light">
            <DeviceReplacementPanel pool={sourcePool} canWrite={canWrite} />
          </ThemeProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    ),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  serial = 0;
  bodies = [];
  saved = false;
  cancelled = false;
  canPrepare = true;
  fail = undefined;
  randomUUID
    .mockReset()
    .mockImplementation(() => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++serial).padStart(12, "0")}`);
  vi.stubGlobal("crypto", { randomUUID });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== "POST")
        return response({
          canPrepare,
          items: saved
            ? [
                {
                  preparation: {
                    ...preparation,
                    ...(cancelled
                      ? { state: "cancelled", revision: 2, cancelledAt: "2026-09-12T10:01:00.000Z" }
                      : {}),
                  },
                  needsReview: true,
                },
              ]
            : [],
        });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push({ url, body });
      if (url.endsWith("/confirm")) saved = true;
      if (url.endsWith("/cancel")) cancelled = true;
      const failed = fail?.(url, body);
      if (failed) return failed;
      if (url.endsWith("/preview")) return response(preview(String(body.requestId)));
      return response({
        requestId: body.requestId,
        preparation: {
          ...preparation,
          ...(cancelled
            ? { state: "cancelled", revision: 2, cancelledAt: "2026-09-12T10:01:00.000Z" }
            : {}),
        },
      });
    }),
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  authRefetch.mockReset();
  await i18n.changeLanguage("ru");
});
async function selectSource(name = "Source 1") {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Source device" }));
  await user.click(screen.getByRole("option", { name }));
}
async function fill() {
  const user = userEvent.setup();
  await selectSource();
  await user.type(screen.getByLabelText("Future device name"), "Future device");
  await user.click(screen.getByRole("combobox", { name: "Future device kind" }));
  await user.click(screen.getByRole("option", { name: "Handheld" }));
  await user.type(screen.getByLabelText("Reason"), "Private support reason");
}
async function inspect() {
  await fill();
  await userEvent.click(screen.getByRole("button", { name: "Preview preparation" }));
  await screen.findByRole("button", { name: "Save preparation" });
}
it("previews known server work and unknown local queues, saves preparation without operational actions", async () => {
  setup();
  expect(screen.queryByLabelText("Future device name")).toBeNull();
  await inspect();
  expect(screen.getByText(/Local journals, outbox and print work are unknown/)).toBeDefined();
  expect(screen.getByText(/Active shifts: 2/)).toBeDefined();
  expect(screen.getByText(/Current slots: 1 of 2/)).toBeDefined();
  expect(screen.getByText(/Preparation changes slots by 0/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await screen.findByText("Prepared");
  expect(bodies.map((x) => x.url)).toEqual([
    "/api/platform/tenants/tenant-1/device-licensing/" + SOURCE + "/replacements/preview",
    "/api/platform/tenants/tenant-1/device-licensing/" + SOURCE + "/replacements/confirm",
  ]);
  expect(bodies[1]?.body).toEqual({
    requestId: bodies[0]?.body.requestId,
    previewId: "33333333-3333-4333-8333-333333333333",
  });
  expect(randomUUID).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(bodies)).not.toMatch(/pairing-code|DELETE|execute|force/);
  expect(screen.queryByText("Private support reason")).toBeNull();
});
it("supports readonly saved projects and authoritative permission denial", async () => {
  saved = true;
  canPrepare = false;
  setup(undefined, false);
  await screen.findByText("Needs review");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel preparation" })).toBeNull();
  expect(screen.getByText(/Local journals/)).toBeDefined();
});
it("includes security-released legacy candidates with null public pairing timestamps", async () => {
  setup(undefined, true, {
    ...pool,
    devices: [
      {
        ...pool.devices[0]!,
        state: "released",
        slotOccupied: false,
        releaseReason: "security_revoked",
      },
    ],
  });
  await selectSource();
  expect(screen.getByLabelText("Future device name")).toBeDefined();
});
it("invalidates preview and creates a new identity after target editing", async () => {
  setup();
  await inspect();
  await userEvent.type(screen.getByLabelText("Reason"), " changed");
  expect(screen.queryByRole("button", { name: "Save preparation" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Preview preparation" }));
  await screen.findByRole("button", { name: "Save preparation" });
  expect(bodies[1]?.body.requestId).not.toBe(bodies[0]?.body.requestId);
});
it.each(["preview", "confirm", "cancel"])(
  "keeps %s request identity after ambiguous response and remount",
  async (action) => {
    if (action === "cancel") saved = true;
    let lost = false;
    fail = (url) => {
      if (url.endsWith("/" + action) && !lost) {
        lost = true;
        return Promise.reject(new TypeError("lost"));
      }
    };
    const view = setup();
    if (action === "cancel") {
      await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
      await userEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Confirm cancellation",
        }),
      );
    } else {
      await fill();
      await userEvent.click(screen.getByRole("button", { name: "Preview preparation" }));
      if (action === "confirm")
        await userEvent.click(await screen.findByRole("button", { name: "Save preparation" }));
    }
    await screen.findByText(/Result is unknown/);
    const before = bodies.filter((x) => x.url.endsWith("/" + action))[0]?.body;
    const key =
      action === "cancel"
        ? replacementKeys.cancel(pool.tenantId, SOURCE, preparation.id)
        : replacementKeys.prepare(pool.tenantId, SOURCE);
    const cached = view.client.getQueryData<PrepareAttempt | CancelAttempt>(key);
    expect(cached?.request).toEqual(action === "confirm" ? bodies[0]?.body : before);
    if (action === "confirm") {
      const preparedAttempt = view.client.getQueryData<PrepareAttempt>(key);
      expect({
        requestId: preparedAttempt?.request?.requestId,
        previewId: preparedAttempt?.preview?.id,
      }).toEqual(before);
    }
    expect(view.client.getQueryCache().find({ queryKey: key, exact: true })?.options.gcTime).toBe(
      Infinity,
    );
    view.unmount();
    setup(view.client);
    if (action === "cancel") {
      await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
      await userEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Confirm cancellation",
        }),
      );
    } else
      await userEvent.click(
        await screen.findByRole("button", {
          name: action === "preview" ? "Preview preparation" : "Save preparation",
        }),
      );
    await waitFor(() => expect(bodies.filter((x) => x.url.endsWith("/" + action))).toHaveLength(2));
    expect(bodies.filter((x) => x.url.endsWith("/" + action))[1]?.body).toEqual(before);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  },
);
it("preserves the in-flight lock across remount and settles in the cache", async () => {
  let resolve: ((value: Response) => void) | undefined;
  fail = (url, body) =>
    url.endsWith("/confirm")
      ? new Promise<Response>((done) => {
          resolve = () => done(response({ requestId: body.requestId, preparation }));
        })
      : undefined;
  const view = setup();
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  view.unmount();
  setup(view.client);
  expect(
    (await screen.findByRole("button", { name: "Save preparation" })).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByLabelText("Future device name").closest("fieldset")?.disabled).toBe(true);
  expect(randomUUID).toHaveBeenCalledTimes(1);
  await act(async () => resolve?.(response({})));
  await screen.findByText("Prepared");
  expect(bodies.filter((x) => x.url.endsWith("/confirm"))).toHaveLength(1);
});
it("restores uncertain source intent after navigating to another source", async () => {
  fail = (url) => (url.endsWith("/confirm") ? Promise.reject(new TypeError("lost")) : undefined);
  setup();
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await screen.findByText(/Result is unknown/);
  await selectSource("Source 2");
  expect((screen.getByLabelText("Future device name") as HTMLInputElement).value).toBe("");
  await selectSource();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await waitFor(() => expect(bodies.filter((x) => x.url.endsWith("/confirm"))).toHaveLength(2));
  expect(bodies[2]?.body).toEqual(bodies[1]?.body);
  expect(randomUUID).toHaveBeenCalledTimes(1);
});
it.each([200, 401, 403, 409])("retains confirm identity for malformed HTTP %i", async (status) => {
  fail = (url) => (url.endsWith("/confirm") ? response({ message: "bad" }, status) : undefined);
  const view = setup();
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await screen.findByText(/Result is unknown/);
  view.unmount();
  setup(view.client);
  await userEvent.click(await screen.findByRole("button", { name: "Save preparation" }));
  await waitFor(() => expect(bodies).toHaveLength(3));
  expect(bodies[2]?.body).toEqual(bodies[1]?.body);
  expect(randomUUID).toHaveBeenCalledTimes(1);
  expect(authRefetch).not.toHaveBeenCalled();
});
it("closes known authorization denial and refreshes current permissions", async () => {
  fail = (url) =>
    url.endsWith("/confirm")
      ? response(
          {
            code: "forbidden",
            message: "Forbidden",
            requestId: "11111111-1111-4111-8111-111111111111",
          },
          403,
        )
      : undefined;
  setup();
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await screen.findByText(/Session or permissions changed/);
  expect(screen.queryByRole("button", { name: "Save preparation" })).toBeNull();
  expect(authRefetch).toHaveBeenCalledTimes(1);
});
it("requires fresh preview and explicit confirmation after known conflict", async () => {
  fail = (url) =>
    url.endsWith("/confirm")
      ? response(
          {
            code: "device_replacement_stale",
            message: "Conflict",
            requestId: "11111111-1111-4111-8111-111111111111",
          },
          409,
        )
      : undefined;
  setup();
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await screen.findByText(/Facts changed/);
  expect(screen.queryByRole("button", { name: "Save preparation" })).toBeNull();
  expect((screen.getByLabelText("Future device name") as HTMLInputElement).value).toBe(
    "Future device",
  );
  await userEvent.click(screen.getByRole("button", { name: "Preview preparation" }));
  await screen.findByRole("button", { name: "Save preparation" });
  expect(bodies.filter((x) => x.url.endsWith("/confirm"))).toHaveLength(1);
  expect(bodies[2]?.body.requestId).not.toBe(bodies[0]?.body.requestId);
});
it("does not cancel a saved preparation before explicit confirmation", async () => {
  saved = true;
  setup();
  await screen.findByText("Needs review");
  await userEvent.click(screen.getByRole("button", { name: "Cancel preparation" }));
  expect(bodies).toHaveLength(0);
  expect(
    within(screen.getByRole("alertdialog")).getByText(/source device remains unchanged/),
  ).toBeDefined();
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  await screen.findByText("Cancelled");
  expect(bodies[0]?.body).toEqual({ requestId: expect.any(String), expectedRevision: 1 });
});

it("honors server canPrepare even when the local write capability is present", async () => {
  canPrepare = false;
  setup(undefined, true);
  await screen.findByText(/You can inspect saved preparations/);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(bodies).toHaveLength(0);
});

it("keeps the original source response isolated after tenant navigation", async () => {
  let complete: (() => void) | undefined;
  fail = (url, body) =>
    url.endsWith("/confirm")
      ? new Promise<Response>((resolve) => {
          complete = () => resolve(response({ requestId: body.requestId, preparation }));
        })
      : undefined;
  const view = setup();
  await inspect();
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  view.unmount();
  setup(view.client, true, { ...pool, tenantId: "tenant-2" });
  await screen.findByRole("combobox", { name: "Source device" });
  expect(screen.queryByLabelText("Future device name")).toBeNull();
  await act(async () => complete?.());
  expect(screen.queryByLabelText("Future device name")).toBeNull();
  expect(randomUUID).toHaveBeenCalledTimes(1);
});

it("formats the saved observation date in the selected Russian locale", async () => {
  await i18n.changeLanguage("ru");
  saved = true;
  setup();
  await screen.findByText(
    `Наблюдение сохранено ${new Date(preparation.preparedAt).toLocaleString("ru")}; это исторические факты.`,
  );
  expect(screen.getByText(/сохранённые задания печати: 3/)).toBeDefined();
  expect(screen.getByText("Замену пока нельзя завершить")).toBeDefined();
  expect(screen.getByText("Перенос доступа с исходного устройства ещё недоступен")).toBeDefined();
});

it("invalidates an ordinary source preview across A to B to A while retaining intent", async () => {
  const view = setup();
  await inspect();
  const firstRequest = bodies[0]?.body;
  await selectSource("Source 2");
  await selectSource("Source 1");
  expect(screen.queryByRole("button", { name: "Save preparation" })).toBeNull();
  expect((screen.getByLabelText("Future device name") as HTMLInputElement).value).toBe(
    "Future device",
  );
  const key = replacementKeys.prepare(pool.tenantId, SOURCE);
  expect(view.client.getQueryData<PrepareAttempt>(key)?.request).toBeUndefined();
  expect(view.client.getQueryData<PrepareAttempt>(key)?.preview).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "Preview preparation" }));
  await screen.findByRole("button", { name: "Save preparation" });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.body.requestId).not.toBe(firstRequest?.requestId);
  expect(randomUUID).toHaveBeenCalledTimes(2);
  expect(bodies.every((call) => call.url.endsWith("/preview"))).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save preparation" }));
  await screen.findByText("Prepared");
  expect(bodies[2]?.body.requestId).toBe(bodies[1]?.body.requestId);
});

it("explains a lost result inside the active cancellation dialog and retries the same body", async () => {
  saved = true;
  let lost = false;
  fail = (url) => {
    if (url.endsWith("/cancel") && !lost) {
      lost = true;
      return Promise.reject(new TypeError("lost"));
    }
  };
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  const dialog = screen.getByRole("alertdialog");
  await within(dialog).findByText(/Result is unknown/);
  expect(within(dialog).getByRole("alert")).toBeDefined();
  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
  await screen.findByText("Cancelled");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.body).toEqual(bodies[0]?.body);
  expect(randomUUID).toHaveBeenCalledTimes(1);
});

it.each(["ru", "en"])(
  "labels persisted usage as historical in %s and preserves the saved snapshot",
  async (language) => {
    await i18n.changeLanguage(language);
    saved = true;
    setup(undefined, false, { ...pool, usage: 5, limit: 7 });
    const project = await screen.findByRole("region", {
      name: language === "ru" ? "Сохранённая подготовка замены" : "Saved replacement preparation",
    });
    expect(
      within(project).getByText(
        language === "ru"
          ? "На момент сохранения занято мест: 1 из 2."
          : "Slots at preparation: 1 of 2.",
      ),
    ).toBeDefined();
    expect(
      within(project).queryByText(/Current slots|Сейчас занято мест|5 of 7|5 из 7/),
    ).toBeNull();
  },
);

it("keeps uncertain cancellation visible and its identity intact when write permission is lost", async () => {
  saved = true;
  fail = (url) => (url.endsWith("/cancel") ? Promise.reject(new TypeError("lost")) : undefined);
  const view = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  await within(screen.getByRole("alertdialog")).findByText(/Result is unknown/);
  const key = replacementKeys.cancel(pool.tenantId, SOURCE, preparation.id);
  const originalRequest = view.client.getQueryData<CancelAttempt>(key)?.request;
  expect(originalRequest).toEqual(bodies[0]?.body);
  view.rerender(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={view.client}>
        <ThemeProvider defaultTheme="light">
          <DeviceReplacementPanel pool={pool} canWrite={false} />
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByText(/Result is unknown/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Cancel preparation" })).toBeNull();
  expect(view.client.getQueryData<CancelAttempt>(key)?.request).toEqual(originalRequest);
  expect(randomUUID).toHaveBeenCalledTimes(1);
});

it.each(["preview", "confirm"])(
  "preserves the uncertain %s request and preview through attempted form edits and retry",
  async (action) => {
    let lost = false;
    fail = (url) => {
      if (url.endsWith("/" + action) && !lost) {
        lost = true;
        return Promise.reject(new TypeError("lost"));
      }
    };
    const view = setup();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Preview preparation" }));
    if (action === "confirm") {
      await userEvent.click(await screen.findByRole("button", { name: "Save preparation" }));
    }
    await screen.findByText(/Result is unknown/);
    const key = replacementKeys.prepare(pool.tenantId, SOURCE);
    const request = {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      target: { name: "Future device", kind: "handheld" },
      reason: "Private support reason",
    };
    const expected = {
      intent: { name: "Future device", kind: "handheld", reason: "Private support reason" },
      request,
      ...(action === "confirm" ? { preview: preview(request.requestId) } : {}),
      pending: false,
      notice: "uncertain",
    };
    expect(view.client.getQueryData<PrepareAttempt>(key)).toEqual(expected);
    // Direct change events also exercise the handler guard behind disabled inputs.
    fireEvent.change(screen.getByLabelText("Future device name"), {
      target: { value: "Different device" },
    });
    expect(view.client.getQueryData<PrepareAttempt>(key)).toEqual(expected);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Different reason" },
    });
    expect(view.client.getQueryData<PrepareAttempt>(key)).toEqual(expected);
    await userEvent.click(screen.getByRole("combobox", { name: "Future device kind" }));
    expect(screen.queryByRole("option", { name: "Station" })).toBeNull();
    expect(view.client.getQueryData<PrepareAttempt>(key)).toEqual(expected);
    expect(screen.getByLabelText("Future device name").closest("fieldset")?.disabled).toBe(true);
    const retry = screen.getByRole("button", {
      name: action === "preview" ? "Preview preparation" : "Save preparation",
    });
    expect(retry.hasAttribute("disabled")).toBe(false);
    await userEvent.click(retry);
    if (action === "preview") {
      await screen.findByRole("button", { name: "Save preparation" });
      expect(view.client.getQueryData<PrepareAttempt>(key)).toEqual({
        intent: expected.intent,
        request,
        preview: preview(request.requestId),
      });
    } else {
      await screen.findByText("Prepared");
    }
    const attempts = bodies.filter((entry) => entry.url.endsWith("/" + action));
    const expectedBody =
      action === "preview"
        ? request
        : { requestId: request.requestId, previewId: "33333333-3333-4333-8333-333333333333" };
    expect(attempts.map((entry) => entry.body)).toEqual([expectedBody, expectedBody]);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  },
);

it("clears a cancellation conflict after a successful fresh attempt", async () => {
  saved = true;
  let conflicted = false;
  fail = (url) => {
    if (url.endsWith("/cancel") && !conflicted) {
      conflicted = true;
      cancelled = false;
      return response(
        {
          code: "device_replacement_stale",
          message: "Conflict",
          requestId: "11111111-1111-4111-8111-111111111111",
        },
        409,
      );
    }
  };
  const view = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Cancel preparation" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  await screen.findByText(/Facts changed/);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Cancel preparation" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  await screen.findByText("Cancelled");
  expect(screen.queryByText(/Facts changed/)).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel preparation" })).toBeNull();
  expect(bodies.map((entry) => entry.body)).toEqual([
    { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", expectedRevision: 1 },
    { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002", expectedRevision: 1 },
  ]);
  expect(view.client.getQueryData(replacementKeys.list(pool.tenantId))).toEqual({
    canPrepare: true,
    items: [
      {
        preparation: {
          ...preparation,
          state: "cancelled",
          revision: 2,
          cancelledAt: "2026-09-12T10:01:00.000Z",
        },
        needsReview: true,
      },
    ],
  });
  expect(
    view.client.getQueryData(replacementKeys.cancel(pool.tenantId, SOURCE, preparation.id)),
  ).toBeNull();
});
