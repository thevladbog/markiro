import { readFileSync } from "node:fs";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  cloudImportSummarySchema,
  fileChecksum,
  readCloudExportFile,
  type CloudExportFile,
  type CloudImportRequest,
  type CloudImportSummary,
} from "../src/host/cloud-import.js";
import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import ru from "../src/i18n/ru.json";
import { Office } from "../src/office/Office.js";
import type * as OfficeQuery from "../src/office/office-query.js";
import {
  KNOWN_NOTE_CODES,
  NOTE_ENTITIES,
  NOTE_FIELDS,
  NOTE_PURPOSES,
  NOTE_REASONS,
  noteText,
} from "../src/office/import/import-notes.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

// The office makes its query client itself; the test keeps hold of it to look into its caches.
const made = vi.hoisted(() => ({ clients: [] as QueryClient[] }));
vi.mock("../src/office/office-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OfficeQuery>();
  return {
    ...actual,
    createOfficeQueryClient: () => {
      const client = actual.createOfficeQueryClient();
      made.clients.push(client);
      return client;
    },
  };
});

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const GOLDEN = readFileSync(
  new URL("../proto/fixtures/cloud-export-file.json", testModuleUrl),
  "utf8",
);
const SUMMARY = cloudImportSummarySchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/cloud-import-summary.json", testModuleUrl), "utf8"),
  ),
);
/** The site's profile with the file's GLN, as after a wizard run from the file. */
const SITE_ORG = { ...ORG_PROFILE, gln: "4600682000010" };

/** A summary whose every number differs, so a count under the wrong label shows. */
const DISTINCT: CloudImportSummary = {
  ...SUMMARY,
  linesCreated: 21,
  linesPresent: 4,
  counterparties: 22,
  templates: 23,
  orgDefaults: 5,
  categoryDefaults: 7,
  products: 24,
  operators: 25,
  badges: 26,
};

/** The verifiers and the salt of the golden file: what must never leave the ref. */
const SECRETS: string[] = (() => {
  const file = JSON.parse(GOLDEN) as {
    payload: {
      operators: { pinPhc: string }[];
      badges: { badgePhc: string }[];
      badgeSalt: string;
    };
  };
  const list = [
    ...file.payload.operators.map((each) => each.pinPhc),
    ...file.payload.badges.map((each) => each.badgePhc),
    file.payload.badgeSalt,
  ];
  if (list.length < 7 || list.some((each) => each.length < 20)) throw new Error("fixture changed");
  return list;
})();

/** Whether `value` holds a secret anywhere (a boolean only: a failure must not print one). */
function holds(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (typeof value === "string") return SECRETS.some((each) => value.includes(each));
  if (value === null || typeof value !== "object" || depth > 40) return false;
  if ((value as { nodeType?: unknown }).nodeType !== undefined) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    return [...value.entries()].some(
      ([key, each]) => holds(key, seen, depth + 1) || holds(each, seen, depth + 1),
    );
  }
  if (value instanceof Set) return [...value].some((each) => holds(each, seen, depth + 1));
  return Object.keys(value).some((key) => {
    if (
      key.startsWith("_") ||
      ["return", "alternate", "stateNode", "child", "sibling"].includes(key)
    ) {
      return false;
    }
    return holds((value as Record<string, unknown>)[key], seen, depth + 1);
  });
}

interface Fiber {
  tag: number;
  memoizedState: unknown;
  memoizedProps: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
}
interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}

function rootFiber(view: RenderResult): Fiber {
  const key = Object.keys(view.container).find((each) => each.startsWith("__reactContainer$"));
  if (key === undefined) throw new Error("no React root on the container");
  return (view.container as unknown as Record<string, Fiber>)[key]!;
}

function fibers(fiber: Fiber | null): Fiber[] {
  const all: Fiber[] = [];
  for (let each = fiber; each !== null; each = each.sibling) {
    all.push(each, ...fibers(each.child));
  }
  return all;
}

function hooksOf(fiber: Fiber): Hook[] {
  const state = fiber.memoizedState as Hook | null | undefined;
  if (state === null || typeof state !== "object" || !("next" in state)) return [];
  const list: Hook[] = [];
  for (let hook: Hook | null = state; hook !== null; hook = hook.next) list.push(hook);
  return list;
}

function isRef(state: unknown): state is { current: unknown } {
  return (
    state !== null &&
    typeof state === "object" &&
    Object.keys(state).length === 1 &&
    "current" in state
  );
}

/** Whether the component tree holds a secret in a state, a context or a prop (a ref is not looked into). */
function treeHolds(view: RenderResult): boolean {
  return fibers(rootFiber(view)).some((fiber) => {
    if (fiber.tag === 3) return false;
    const inHooks = hooksOf(fiber).some(
      (hook) => !isRef(hook.memoizedState) && holds(hook.memoizedState),
    );
    return inHooks || holds(fiber.memoizedProps);
  });
}

/** The ref that holds the file read, if there is one. */
function heldRef(view: RenderResult): { current: unknown } | null {
  for (const fiber of fibers(rootFiber(view))) {
    for (const hook of hooksOf(fiber)) {
      const state = hook.memoizedState;
      if (isRef(state) && state.current !== null && typeof state.current === "object") {
        if ("importId" in state.current && "file" in state.current) return state;
      }
    }
  }
  return null;
}

function cachesHold(): boolean {
  return made.clients.some(
    (client) =>
      client
        .getQueryCache()
        .getAll()
        .some((query) => holds(query.state)) ||
      client
        .getMutationCache()
        .getAll()
        .some((mutation) => holds(mutation.state)),
  );
}

function pageHolds(view: RenderResult): boolean {
  return (
    SECRETS.some((each) => document.body.innerHTML.includes(each)) ||
    treeHolds(view) ||
    cachesHold() ||
    holds({ ...localStorage }) ||
    holds({ ...sessionStorage }) ||
    holds(location.href)
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(SITE_ORG);
  return session;
}

async function openImport(session: FakeOfficeSession): Promise<RenderResult> {
  const view = renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Перенос из облака" }));
  await screen.findByRole("heading", { name: "Перенос из облака" });
  return view;
}

function choose(text: string): void {
  chooseFile(new File([text], "markiro-cloud-export.json", { type: "application/json" }));
}

function chooseFile(file: File): void {
  fireEvent.change(screen.getByTestId("file-drop-input"), { target: { files: [file] } });
}

/** The golden file with `change` applied, its checksum computed again. */
async function rewritten(change: (file: Record<string, unknown>) => void): Promise<string> {
  const file = JSON.parse(GOLDEN) as Record<string, unknown>;
  change(file);
  file.checksum = await fileChecksum(file);
  return JSON.stringify(file);
}

function sent(session: FakeOfficeSession): CloudImportRequest[] {
  return session.api.importFromCloud.mock.calls.map(([, request]) => request);
}

/** The confirmation dialog takes no press in its first 400 ms; a user's real press comes later. */
const afterPressGuard = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 440));
  });

async function confirm(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Перенести" }));
  const dialog = await screen.findByRole("dialog");
  await afterPressGuard();
  return dialog;
}

function cells(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole(row.querySelector("th") === null ? "cell" : "columnheader")
    .map((cell) => cell.textContent ?? "");
}

function valueOf(term: string): string {
  const label = screen.getByText(term, { selector: "dt" });
  return label.nextElementSibling?.textContent ?? "";
}

afterEach(() => {
  made.clients.length = 0;
  vi.restoreAllMocks();
});

describe("«Перенос из облака»", () => {
  it("is in the menu of an administrator only", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    renderOffice(session);
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Перенос из облака" })).toBeNull();
  });

  it("closes, and drops the file, when the user's role changes to technologist", async () => {
    const session = adminSession();
    const view = await openImport(session);
    choose(GOLDEN);
    await screen.findByRole("button", { name: "Проверить" });
    const ref = heldRef(view);
    expect(ref?.current).not.toBeNull();
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office
          session={{ ...session, user: { ...session.user, role: "technologist" } }}
          labels={quietLabelRendering()}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
    expect(ref?.current).toBeNull();
  });

  it("refuses a damaged file before anything reaches the host", async () => {
    const session = adminSession();
    await openImport(session);
    choose(GOLDEN.replace('"boxCapacity": 12', '"boxCapacity": 24'));
    expect(
      await screen.findByText(
        "Контрольная сумма не сходится: файл изменён или повреждён после выгрузки. Сделайте выгрузку заново.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
    expect(session.api.importFromCloud).not.toHaveBeenCalled();
  });

  it("says in words why a file cannot be read: not JSON, other shape, not .json, not readable, too big", async () => {
    const session = adminSession();
    const view = await openImport(session);
    choose("{ not json");
    expect(
      await screen.findByText("Это не файл переноса: он не читается как JSON или обрезан."),
    ).toBeTruthy();
    choose(
      await rewritten((file) => {
        const payload = file.payload as { products: Record<string, unknown>[] };
        payload.products[0]!.surprise = 1;
      }),
    );
    expect(
      await screen.findByText(
        "Файл не принят: поле «payload.products.0» не того вида. Скорее всего, он сделан другой версией выгрузки или испорчен.",
      ),
    ).toBeTruthy();
    // A file that is not a `.json` one never reaches the reader.
    chooseFile(new File(["x"], "export.txt", { type: "text/plain" }));
    expect(await screen.findByText("Нужен файл переноса с расширением .json.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
    // A file the system cannot read.
    const broken = new File(["x"], "export.json", { type: "application/json" });
    Object.defineProperty(broken, "text", { value: () => Promise.reject(new Error("EIO")) });
    chooseFile(broken);
    expect(
      await screen.findByText(
        "Файл не удалось прочитать: проверьте флешку и права на файл и выберите его снова.",
      ),
    ).toBeTruthy();
    // A file past the host's body limit is refused before it is read at all.
    const huge = new File(["x"], "export.json", { type: "application/json" });
    const text = vi.fn(() => Promise.resolve("{}"));
    Object.defineProperty(huge, "text", { value: text });
    Object.defineProperty(huge, "size", { value: 33 * 1024 * 1024 });
    chooseFile(huge);
    expect(await screen.findByText("Это не файл переноса этой версии автонома.")).toBeTruthy();
    expect(text).not.toHaveBeenCalled();
    expect(heldRef(view)).toBeNull();
    expect(session.api.importFromCloud).not.toHaveBeenCalled();
  });

  it("shows the file, the counters and the notes, and imports only after a check", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockResolvedValueOnce(SUMMARY);
    await openImport(session);
    choose(GOLDEN);

    expect(await screen.findByText("ООО «Атолл», ИНН 7701234567, GLN 4600682000010")).toBeTruthy();
    expect(screen.queryByText(/не совпадает с файлом/)).toBeNull();
    expect(valueOf("Контрольная сумма")).toBe("sha256:9716b9df…");
    expect(valueOf("Организация в облаке")).not.toBe("");
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText("30000")).toBeTruthy();
    expect(within(rows[1]!).getByText("1030000")).toBeTruthy();
    expect(within(rows[3]!).getByText("контрагента «ООО «Берег»»")).toBeTruthy();
    expect(rows.map(cells)).toEqual([
      ["Префикс", "Что", "Чей", "Облако выдало до", "Автоном начнёт с", "Облако перевести на"],
      ["460068200", "короба", "организации", "21003", "30000", "1030000"],
      ["460068200", "паллеты", "организации", "400", "10000", "110000"],
      ["460123400", "короба", "контрагента «ООО «Берег»»", "—", "1", "1000001"],
    ]);
    expect(
      screen.getByText("Номера смен продолжат облачные: NOV26 → 1, OCT26 → 7, SEP26 → 41."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Замечания выгрузки: 24" })).toBeTruthy();
    expect(
      screen.getByText(
        "Линия « линия 1 » переименована в «линия 1 (2)»: имена линий не повторяются.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Оператор #0f0f0000 не перенесён: табельный номер не из 3–12 цифр."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(
      await screen.findByText("Проверка пройдена: перенос запишет то, что ниже."),
    ).toBeTruthy();
    const [trial] = sent(session);
    expect(trial?.dryRun).toBe(true);
    expect(trial?.importId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const read = await readCloudExportFile(GOLDEN);
    expect(trial?.payload).toEqual((read as { file: CloudExportFile }).file.payload);

    const dialog = await confirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    expect(
      await screen.findByText(
        "Данные облака перенесены. Станции получат их при следующей синхронизации.",
      ),
    ).toBeTruthy();
    const [, done] = sent(session);
    expect(done?.dryRun).toBe(false);
    expect(done?.importId).toBe(trial?.importId);
    expect(
      screen.getByText("Удалите файл переноса с флешки и с этого ПК: в нём хеши PIN и бейджей."),
    ).toBeTruthy();
    expect(screen.getByText(/Станции получат линии, товары, шаблоны/)).toBeTruthy();
    expect(screen.getByText(/Переведите облачные счётчики SSCC/)).toBeTruthy();
    // The office's cached data was dropped: the profile is read again.
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Убрать файл" })).toBeNull();
  });

  it("tells an owner nobody knows and a window that does not fit, and an empty file's lists", async () => {
    const session = adminSession();
    const odd = await rewritten((file) => {
      const counters = (file.cutover as { ssccCounters: Record<string, unknown>[] }).ssccCounters;
      counters[0]!.owner = { kind: "unknown" };
      counters[1]!.cloudReseedTo = null;
    });
    const empty = await rewritten((file) => {
      (file.cutover as { ssccCounters: unknown[] }).ssccCounters = [];
      (file.payload as { shiftNumberCounters: unknown[] }).shiftNumberCounters = [];
      file.notes = [];
    });
    await openImport(session);
    choose(odd);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(cells(rows[1]!)[2]).toBe("неизвестно");
    expect(cells(rows[2]!)[5]).toBe("окно не помещается");
    choose(empty);
    expect(await screen.findByText("SSCC в облаке не выдавались")).toBeTruthy();
    expect(screen.getByText("Номера смен продолжат облачные: —.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Замечания выгрузки: 0" })).toBeTruthy();
    expect(
      screen.getByText("Выгрузка ничего не изменила и ничего не оставила в облаке."),
    ).toBeTruthy();
  });

  it("shows the file, and no GLN warning, when the site's profile cannot be read", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockRejectedValue(new Error("profile"));
    await openImport(session);
    choose(GOLDEN);
    expect(await screen.findByText("ООО «Атолл», ИНН 7701234567, GLN 4600682000010")).toBeTruthy();
    expect(screen.queryByText(/не совпадает с файлом/)).toBeNull();
    expect(screen.getByRole("button", { name: "Проверить" })).toHaveProperty("disabled", false);
  });

  it("holds the file in a ref only, and nothing of it reaches the page, the caches, storage or the console", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockResolvedValueOnce(SUMMARY);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const view = await openImport(session);
    expect(pageHolds(view)).toBe(false);
    choose(GOLDEN);
    await screen.findByRole("button", { name: "Проверить" });
    // The scan sees what it should: the ref does hold the file.
    const ref = heldRef(view);
    expect(holds(ref?.current)).toBe(true);
    expect(pageHolds(view)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    expect(pageHolds(view)).toBe(false);
    const dialog = await confirm();
    expect(pageHolds(view)).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    await screen.findByText(
      "Данные облака перенесены. Станции получат их при следующей синхронизации.",
    );
    // Done: the ref is empty, and the whole page, ref included, holds nothing.
    expect(ref?.current).toBeNull();
    expect(heldRef(view)).toBeNull();
    expect(pageHolds(view)).toBe(false);
    expect(spies.some((spy) => holds(spy.mock.calls))).toBe(false);
    // The request itself went to the host, which is where the hashes belong.
    expect(holds(sent(session))).toBe(true);
  });

  it("drops the file at the end of a flow: on another file, on taking it away", async () => {
    const session = adminSession();
    const view = await openImport(session);
    choose(GOLDEN);
    await screen.findByRole("button", { name: "Убрать файл" });
    const first = heldRef(view);
    const firstId = (first?.current as { importId: string }).importId;
    choose(await rewritten((file) => (file.rehearsal = true)));
    await screen.findByText(/^Пробный файл:/);
    // The same ref, now another read with another import id.
    const second = heldRef(view);
    expect(second).toBe(first);
    expect((second?.current as { importId: string }).importId).not.toBe(firstId);
    fireEvent.click(screen.getByRole("button", { name: "Убрать файл" }));
    expect(heldRef(view)).toBeNull();
    expect(screen.queryByRole("button", { name: "Проверить" })).toBeNull();
    expect(screen.queryByText(/^Пробный файл:/)).toBeNull();
    expect(session.api.importFromCloud).not.toHaveBeenCalled();
  });

  it("drops the file when the page closes in the middle of the import, and ignores the late answer", async () => {
    const session = adminSession();
    const answer = deferred<CloudImportSummary>();
    session.api.importFromCloud.mockReturnValueOnce(answer.promise);
    const view = await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(session.api.importFromCloud).toHaveBeenCalledTimes(1));
    const ref = heldRef(view);
    expect(holds(ref?.current)).toBe(true);
    view.unmount();
    expect(ref?.current).toBeNull();
    await act(async () => {
      answer.resolve({ ...SUMMARY, dryRun: true });
      await answer.promise;
    });
    // Nothing happened after the page was gone: no reset of the office's cache.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
    expect(sent(session)).toHaveLength(1);
  });

  it("keeps the office's cache as it was when the page closes before the import answers", async () => {
    const session = adminSession();
    const answer = deferred<CloudImportSummary>();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockReturnValueOnce(answer.promise);
    const view = await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    const dialog = await confirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    await waitFor(() => expect(session.api.importFromCloud).toHaveBeenCalledTimes(2));
    const ref = heldRef(view);
    expect(holds(ref?.current)).toBe(true);
    const [client] = made.clients;
    const org = () => client?.getQueryCache().find({ queryKey: ["office", "org"] })?.state.data;
    expect(org()).toEqual(SITE_ORG);
    view.unmount();
    expect(ref?.current).toBeNull();
    await act(async () => {
      answer.resolve(SUMMARY);
      await answer.promise;
    });
    // The page was gone: the answer reset nothing and showed nothing.
    expect(org()).toEqual(SITE_ORG);
  });

  it("drops a file that is still being read when the page closes", async () => {
    const session = adminSession();
    const view = await openImport(session);
    // The page's ref is found while it holds a file, and the file is taken away.
    choose(GOLDEN);
    await screen.findByRole("button", { name: "Убрать файл" });
    const mine = heldRef(view);
    expect(mine).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Убрать файл" }));
    expect(mine?.current).toBeNull();
    // A file still being read when the page closes is never held.
    const slow = new File(["x"], "slow.json", { type: "application/json" });
    const late = deferred<string>();
    Object.defineProperty(slow, "text", { value: () => late.promise });
    const digest = vi.spyOn(crypto.subtle, "digest");
    chooseFile(slow);
    view.unmount();
    await act(async () => {
      late.resolve(GOLDEN);
      await late.promise;
      // The read goes on to its checksum; wait for it to finish.
      await waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
      await digest.mock.results[0]?.value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(mine?.current).toBeNull();
  });

  it("drops a file that is still being read when a newer one is chosen", async () => {
    const session = adminSession();
    const view = await openImport(session);
    const slow = new File(["x"], "slow.json", { type: "application/json" });
    const late = deferred<string>();
    Object.defineProperty(slow, "text", { value: () => late.promise });
    const unreadable = new File(["x"], "unreadable.json", { type: "application/json" });
    const failed = deferred<string>();
    Object.defineProperty(unreadable, "text", { value: () => failed.promise });
    const zone = () => screen.getByText("Выберите файл переноса").closest("[role=button]");
    chooseFile(slow);
    // While a file is read the zone says so and takes no other.
    expect(zone()?.getAttribute("aria-busy")).toBe("true");
    chooseFile(unreadable);
    choose(GOLDEN);
    await screen.findByText("ООО «Атолл», ИНН 7701234567, GLN 4600682000010");
    expect(zone()?.getAttribute("aria-busy")).toBeNull();
    const other = await rewritten((file) => {
      (file.source as { tenantName: string }).tenantName = "Другой арендатор";
      (file.payload as { organization: { name: string } }).organization.name = "Другая организация";
    });
    await act(async () => {
      late.resolve(other);
      failed.reject(new Error("EIO"));
      await late.promise;
    });
    // Let the late reads finish: the page still shows the file chosen last.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText(/Другая организация/)).toBeNull();
    expect(screen.queryByText(/Файл не удалось прочитать/)).toBeNull();
    const held = heldRef(view)?.current as { file: CloudExportFile };
    expect(held.file.payload.organization.name).toBe("ООО «Атолл»");
  });

  it("says a site's other GLN before the import, and the host's refusals in words", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    const refusal = (constraint: string, details: Record<string, unknown>) =>
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "refused",
        details: { constraint, ...details },
      });
    session.api.importFromCloud
      .mockRejectedValueOnce(
        refusal("org_gln", { siteGln: "4600682000013", fileGln: "4600682000010" }),
      )
      .mockRejectedValueOnce(refusal("site_not_empty", { entity: "products" }))
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          status: 400,
          message: "refused",
          details: { field: "payload.badges.0.badgePhc" },
        }),
      );
    await openImport(session);
    choose(GOLDEN);
    expect(
      await screen.findByText(
        "GLN организации на этой площадке (4600682000013) не совпадает с файлом (4600682000010): перенос будет отклонён. Исправьте GLN на странице «Профиль».",
      ),
    ).toBeTruthy();
    const check = screen.getByRole("button", { name: "Проверить" });
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "GLN организации на площадке (4600682000013) не совпадает с файлом (4600682000010). Исправьте GLN на странице «Профиль» и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "На площадке уже есть данные (товары): перенос возможен только на новую площадку.",
      ),
    ).toBeTruthy();
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "Автоном не принял строку файла (payload.badges.0.badgePhc): файл повреждён или сделан другой версией выгрузки.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", true);
  });

  it("names what a site holds in words, whatever the host names, and every other refusal by its code", async () => {
    const session = adminSession();
    const conflict = (constraint: string, details: Record<string, unknown>) =>
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "refused",
        details: { constraint, ...details },
      });
    const entities: [string, string][] = [
      ["shifts", "смены"],
      ["sscc_blocks", "выданные блоки SSCC"],
      ["category_template_defaults", "умолчания шаблонов категорий"],
      ["products", "товары"],
      ["label_templates", "шаблоны"],
      ["operators", "операторы"],
      ["counterparties", "контрагенты"],
      ["something_new", "записи"],
    ];
    for (const [entity] of entities) {
      session.api.importFromCloud.mockRejectedValueOnce(conflict("site_not_empty", { entity }));
    }
    session.api.importFromCloud
      .mockRejectedValueOnce(conflict("already_imported", { importedAt: "2026-10-10T09:00:00Z" }))
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "forbidden", status: 403, message: "x", details: {} }),
      )
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "internal", status: 500, message: "x", details: {} }),
      )
      .mockRejectedValueOnce(new Error("boom"));
    await openImport(session);
    choose(GOLDEN);
    const check = await screen.findByRole("button", { name: "Проверить" });
    for (const [, words] of entities) {
      fireEvent.click(check);
      expect(
        await screen.findByText(
          `На площадке уже есть данные (${words}): перенос возможен только на новую площадку.`,
        ),
      ).toBeTruthy();
    }
    fireEvent.click(check);
    expect(
      await screen.findByText(
        "На площадку уже перенесены данные другого файла (2026-10-10T09:00:00Z).",
      ),
    ).toBeTruthy();
    for (const key of ["errors.api.forbidden", "errors.api.internal", "errors.unknown"]) {
      fireEvent.click(check);
      await waitFor(() => expect(screen.queryAllByText(i18n.t(key))).toHaveLength(1));
    }
  });

  it("sends the same import again after a lost answer, and says the failure once", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "lost" }),
      )
      .mockResolvedValueOnce({ ...SUMMARY, repeated: true });
    await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    let dialog = await confirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    await waitFor(() => expect(session.api.importFromCloud).toHaveBeenCalledTimes(2));
    dialog = await screen.findByRole("dialog");
    // The failure is in the dialog, and not a second time under it on the page.
    await waitFor(() =>
      expect(within(dialog).queryAllByText(i18n.t("errors.transport.unreachable"))).toHaveLength(1),
    );
    expect(screen.queryAllByText(i18n.t("errors.transport.unreachable"))).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    expect(
      await screen.findByText("Этот файл уже перенесён на площадку: показан итог того переноса."),
    ).toBeTruthy();
    const ids = sent(session).map((request) => request.importId);
    expect(new Set(ids).size).toBe(1);
    expect(sent(session).map((request) => request.dryRun)).toEqual([true, false, false]);
  });

  it("marks a rehearsal file and reads a new file as a new import", async () => {
    const session = adminSession();
    session.api.importFromCloud.mockResolvedValue({ ...SUMMARY, dryRun: true });
    // Made before the page opens: an await between the opening and the choice would let
    // the profile's answer arrive outside `act`.
    const rehearsal = await rewritten((file) => {
      file.rehearsal = true;
      file.notes = [{ code: "active_shift", number: "OCT26-008/S" }, ...(file.notes as unknown[])];
    });
    await openImport(session);
    choose(rehearsal);
    expect(
      await screen.findByText(
        "Пробный файл: облако при выгрузке не было чистым (открытая смена или станция без синхронизации). Для переключения он не годится.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Смена OCT26-008/S не была закрыта в облаке.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    // A rehearsal file's confirmation says so.
    const dialog = await confirm();
    expect(
      within(dialog).getByText(
        "Файл пробный: переносите его только на пробную площадку, не на боевую.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    choose(GOLDEN);
    // The new file is read: the earlier file's check is gone with it.
    const check = await screen.findByRole("button", { name: "Проверить" });
    expect(screen.queryByText("Проверка пройдена: перенос запишет то, что ниже.")).toBeNull();
    expect(screen.queryByText(/^Пробный файл:/)).toBeNull();
    fireEvent.click(check);
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    const ids = sent(session).map((request) => request.importId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(sent(session)[1]?.rehearsal).toBe(false);
    // A file that is not a rehearsal one says nothing of it.
    const second = await confirm();
    expect(within(second).queryByText(/Файл пробный/)).toBeNull();
  });

  it("names the counts in the check and in the confirmation, each under its own label", async () => {
    const session = adminSession();
    session.api.importFromCloud.mockResolvedValueOnce({ ...DISTINCT, dryRun: true });
    await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    expect(valueOf("Линии")).toBe("новых 21, уже были 4");
    expect(valueOf("Контрагенты")).toBe("22");
    expect(valueOf("Шаблоны")).toBe("23, умолчаний 12");
    expect(valueOf("Товары")).toBe("24");
    expect(valueOf("Операторы")).toBe("25");
    expect(valueOf("Бейджи")).toBe("26");
    const dialog = await confirm();
    expect(
      within(dialog).getByText(
        /^Будет записано: новых линий 21, контрагентов 22, шаблонов 23, товаров 24, операторов 25, бейджей 26\. .*Отменить перенос нельзя/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("Перенести данные облака?")).toBeTruthy();
  });

  it("ignores a press on the confirmation in its first 400 ms, and takes one after", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockResolvedValueOnce(SUMMARY);
    await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    fireEvent.click(screen.getByRole("button", { name: "Перенести" }));
    const dialog = await screen.findByRole("dialog");
    // The second half of a double click lands on the dialog's button.
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(session.api.importFromCloud).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await afterPressGuard();
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    await screen.findByText(
      "Данные облака перенесены. Станции получат их при следующей синхронизации.",
    );
    expect(sent(session).map((request) => request.dryRun)).toEqual([true, false]);
  });

  it("sends nothing twice: a second press while the host works is dropped, and the controls are off", async () => {
    const session = adminSession();
    const answer = deferred<CloudImportSummary>();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockReturnValueOnce(answer.promise);
    await openImport(session);
    choose(GOLDEN);
    const check = await screen.findByRole("button", { name: "Проверить" });
    fireEvent.click(check);
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", false);
    // Two presses in one moment, before the page has drawn the disabled button.
    act(() => {
      fireEvent.click(check);
      fireEvent.click(check);
    });
    await waitFor(() => expect(session.api.importFromCloud).toHaveBeenCalledTimes(2));
    expect(check).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Убрать файл" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", true);
    expect(
      screen
        .getByText("Выберите файл переноса")
        .closest("[role=button]")
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByTestId("file-drop-input")).toHaveProperty("disabled", true);
    await act(async () => {
      answer.resolve({ ...SUMMARY, dryRun: true });
      await answer.promise;
    });
    await waitFor(() => expect(check).toHaveProperty("disabled", false));
    expect(screen.getByRole("button", { name: "Перенести" })).toHaveProperty("disabled", false);
    expect(session.api.importFromCloud).toHaveBeenCalledTimes(2);
  });

  it("clears the last failure when the next attempt starts", async () => {
    const session = adminSession();
    const answer = deferred<CloudImportSummary>();
    session.api.importFromCloud
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "lost" }),
      )
      .mockReturnValueOnce(answer.promise);
    await openImport(session);
    choose(GOLDEN);
    const check = await screen.findByRole("button", { name: "Проверить" });
    fireEvent.click(check);
    expect(await screen.findByText(i18n.t("errors.transport.unreachable"))).toBeTruthy();
    fireEvent.click(check);
    await waitFor(() => expect(session.api.importFromCloud).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(i18n.t("errors.transport.unreachable"))).toBeNull();
    await act(async () => {
      answer.resolve({ ...SUMMARY, dryRun: true });
      await answer.promise;
    });
    expect(
      await screen.findByText("Проверка пройдена: перенос запишет то, что ниже."),
    ).toBeTruthy();
  });

  it("takes a check that finds the import already made as the end of it", async () => {
    const session = adminSession();
    session.api.importFromCloud.mockResolvedValueOnce({ ...SUMMARY, repeated: true });
    const view = await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    expect(
      await screen.findByText("Этот файл уже перенесён на площадку: показан итог того переноса."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Перенести" })).toBeNull();
    expect(heldRef(view)).toBeNull();
    expect(screen.queryByText("Проверка пройдена: перенос запишет то, что ниже.")).toBeNull();
  });

  it("moves the focus to the result when the import is done", async () => {
    const session = adminSession();
    session.api.importFromCloud
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: true })
      .mockResolvedValueOnce(SUMMARY);
    await openImport(session);
    choose(GOLDEN);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверка пройдена: перенос запишет то, что ниже.");
    const dialog = await confirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Перенести" }));
    const heading = await screen.findByRole("heading", { name: "Перенос выполнен" });
    // The result's own region: the page around it (with the SSCC table) is not what has the focus.
    await waitFor(() => {
      const active = document.activeElement;
      expect(active?.contains(heading)).toBe(true);
      expect(active?.querySelector("table")).toBeNull();
    });
  });
});

describe("the notes of the export tool", () => {
  it("has words for every code the tool writes, and names an unknown one", async () => {
    const read = await readCloudExportFile(GOLDEN);
    const file = (read as { file: CloudExportFile }).file;
    const t = i18n.t.bind(i18n);
    const say = (note: Record<string, unknown>) =>
      noteText(t, { code: "unknown", ...note } as never, file);
    expect(say({ code: "device_out_of_sync", name: "Станция 1" })).toBe(
      "Станция «Станция 1» не отправила данные в облако после последнего закрытия смены.",
    );
    expect(say({ code: "time_zone_replaced", value: "MSK" })).toBe(
      "Часовой пояс «MSK» заменён на Europe/Moscow.",
    );
    expect(say({ code: "line_dropped", id: "0a0a0000-0000-4000-8000-000000000009" })).toBe(
      "Линия без названия не перенесена.",
    );
    expect(say({ code: "badge_salt_created" })).toBe(
      "У организации в облаке не было соли бейджей: создана новая.",
    );
    expect(say({ code: "sscc_window_does_not_fit", issuerPrefix: "460068200", extension: 1 })).toBe(
      "Окно отката не помещается в префикс 460068200 (паллеты): облачный счётчик при откате переводится вручную.",
    );
    expect(say({ code: "sscc_window_does_not_fit", issuerPrefix: "460068200", extension: 0 })).toBe(
      "Окно отката не помещается в префикс 460068200 (короба): облачный счётчик при откате переводится вручную.",
    );
    expect(
      say({
        code: "text_changed",
        entity: "products",
        id: "0e0e0000-0000-4000-8000-000000000001",
        field: "printName",
      }),
    ).toBe(
      "Товар «Молоко 3,2% 0,9 л»: в поле «название для печати» убраны управляющие символы или текст сокращён до допустимой длины.",
    );
    expect(say({ code: "something_new" })).toBe("Замечание «something_new».");
    // A word the tool grows before the office knows it is shown as it stands, not as a missing text.
    expect(
      say({
        code: "product_dropped",
        id: "0e0e0000-0000-4000-8000-000000000001",
        reason: "brand_new",
      }),
    ).toBe("Товар «Молоко 3,2% 0,9 л» не перенесён: brand_new.");
    expect(
      say({ code: "text_changed", entity: "brands", id: "abcdef0123456789", field: "shine" }),
    ).toBe(
      "brands #abcdef01: в поле «shine» убраны управляющие символы или текст сокращён до допустимой длины.",
    );
    expect(say({ code: "template_default_dropped", purpose: "label" })).toBe(
      "Умолчание шаблона (label) не перенесено: шаблон выключен, другого назначения или не охватывает категорию.",
    );
    // Every note of the golden file has its words (a missing key throws in tests).
    for (const note of file.notes) expect(noteText(t, note, file)).not.toBe("");
  });

  it("knows exactly the words the texts have", () => {
    const words = ru.office.cloudImport;
    const sorted = (keys: Iterable<string>) => [...keys].sort();
    expect(sorted(KNOWN_NOTE_CODES)).toEqual(
      sorted(Object.keys(words.notes).filter((key) => key !== "unknown")),
    );
    expect(sorted(NOTE_ENTITIES)).toEqual(sorted(Object.keys(words.entities)));
    expect(sorted(NOTE_FIELDS)).toEqual(sorted(Object.keys(words.fields)));
    expect(sorted(NOTE_REASONS)).toEqual(sorted(Object.keys(words.reasons)));
    expect(sorted(NOTE_PURPOSES)).toEqual(sorted(Object.keys(words.purposes)));
  });
});
