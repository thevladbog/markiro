import { readFileSync } from "node:fs";

import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { standaloneActivationRequestSchema } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import * as SupportKeys from "../src/office/info/support-keys.js";
import { usageStatsSchema } from "../src/host/usage-stats.js";
import { HostError } from "../src/host/client.js";
import type { LicensePreview, LicenseTerms, OfficeLicense } from "../src/host/protocol.js";
import { OfficeFilesError } from "../src/office/exports/office-files.js";
import { Office } from "../src/office/Office.js";
import type * as OfficeQuery from "../src/office/office-query.js";
import { HOST_ID } from "./support/fixtures.js";
import {
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  HOST_FINGERPRINT,
  INN_MISMATCH,
  licenseOf,
  RESTRICTED,
  TRIAL,
  TRIAL_EXPIRED,
  WRONG_HOST,
} from "./support/license.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";
import {
  fakeHostApi,
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const writeText = vi.fn<(text: string) => Promise<void>>();

// The office's query client, to look into its mutation cache: the license's
// text and the activation request must not stay there (spec §9.7).
const clients = vi.hoisted(() => ({ last: null as QueryClient | null }));
vi.mock("../src/office/office-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OfficeQuery>();
  return {
    ...actual,
    createOfficeQueryClient: () => {
      const client = actual.createOfficeQueryClient();
      clients.last = client;
      return client;
    },
  };
});

/** The variables and answers of the writes the office's cache still holds that carry `secret`. */
function heldWith(secret: string): unknown[] {
  const cache = clients.last?.getMutationCache();
  if (cache === undefined) throw new Error("no office query client");
  return cache
    .getAll()
    .map((mutation) => [mutation.state.variables, mutation.state.data])
    .filter((held) => JSON.stringify(held).includes(secret));
}

const FREE_RENEWAL = "Новый файл по истечении срока бесплатно запрашивается у нас.";

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

/** An office session whose host answers `license`, in an organization of Moscow. */
function sessionWith(
  license: OfficeLicense = ACTIVE_LICENSE,
  options: { technologist?: boolean } = {},
): FakeOfficeSession {
  const api = fakeHostApi();
  api.getLicense.mockResolvedValue(license);
  api.getOrg.mockResolvedValue(ORG_PROFILE);
  return fakeOfficeSession({
    api,
    ...(options.technologist === true ? { user: TECHNOLOGIST } : {}),
  });
}

/** «Информация» opened from the office's menu, and its license card once it has loaded. */
async function openLicense(
  session: FakeOfficeSession,
  files: FakeOfficeFiles = fakeOfficeFiles(),
): Promise<HTMLElement> {
  renderOffice(session, { files });
  const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
  fireEvent.click(within(nav).getByRole("link", { name: "Информация" }));
  return licenseCard();
}

/** The license card of «Информация» once it has loaded. */
async function licenseCard(): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name: "Лицензия", level: 2 });
  const card = heading.closest(".mk-card");
  if (!(card instanceof HTMLElement)) throw new Error("no license card");
  await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
  return card;
}

/** The state's alert of the card: its word and the lines of its term. */
function stateOf(card: HTMLElement): HTMLElement {
  const state = card.querySelector(".license-state");
  if (!(state instanceof HTMLElement)) throw new Error("no license state");
  return state;
}

/** The description of a term in the card's definition grid. */
function described(card: HTMLElement, term: string): string {
  const dt = within(card).getByText(term, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

/** The cells of a table's body rows. */
function rowsOf(table: HTMLElement): string[][] {
  return Array.from(table.querySelectorAll("tbody tr")).map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent ?? ""),
  );
}

describe("«Лицензия» on «Информация»", () => {
  it("shows a valid subscription: the state, the term, the seats, the features and the binding", async () => {
    const card = await openLicense(sessionWith());
    const state = stateOf(card);
    expect(state.classList.contains("mk-alert--ok")).toBe(true);
    expect(within(state).getByText("Действует")).toBeTruthy();
    expect(within(state).getByText("Действует по 31.10.2027 включительно.")).toBeTruthy();
    expect(within(state).getByText(FREE_RENEWAL)).toBeTruthy();
    expect(rowsOf(within(card).getByRole("region", { name: "Рабочие места" }))).toEqual([
      ["Станции и ТСД", "3", "5", "в пределах лицензии"],
      ["Пользователи офиса", "2", "3", "в пределах лицензии"],
      ["Линии", "1", "2", "в пределах лицензии"],
    ]);
    const features = within(card).getByRole("region", { name: "Возможности" });
    expect(
      within(features)
        .getAllByRole("listitem")
        .map((item) => [
          item.querySelector("span")?.textContent,
          item.querySelector(".mk-badge")?.textContent,
        ]),
    ).toEqual([
      ["Редактор шаблонов этикеток", "включено"],
      ["Открытый API", "выключено"],
      ["Палеты", "включено"],
      ["Обмен с Честным ЗНАКом", "включено"],
      ["Инвентаризация", "выключено"],
      ["Обмен с 1С (CommerceML)", "выключено"],
      ["ТСД", "включено"],
      ["Логотип организации на формах и этикетках", "включено"],
    ]);
    expect(described(card, "Клиент в лицензии")).toBe("ООО «Атолл»");
    expect(described(card, "ИНН в лицензии")).toBe("7707083893");
    expect(described(card, "ИНН организации в программе")).toBe("7707083893 — совпадает");
    expect(described(card, "Идентификатор хоста")).toBe(HOST_ID);
    expect(described(card, "Отпечаток сертификата хоста")).toBe(HOST_FINGERPRINT);
    expect(described(card, "Файл лицензии")).toBe("№ 3, 5b1d7c2e");
    expect(described(card, "Вид")).toBe("Подписка");
    expect(
      within(card).getByText("Сохраните файл лицензии вместе с документами договора."),
    ).toBeTruthy();
    expect(within(card).queryByText(/может администратор/)).toBeNull();
  });

  it.each([
    [TRIAL, "Пробный период", "mk-alert--info", "Пробный период до 24.10 12:00."],
    [
      DEMO,
      "Демо-лицензия",
      "mk-alert--ok",
      "Демо-лицензия до 03.11.2026 включительно. По окончании демо новые смены не откроются.",
    ],
    [EXPIRING, "Заканчивается", "mk-alert--warn", "Осталось 20 дн."],
    [
      GRACE,
      "Льготный срок",
      "mk-alert--error",
      "Срок лицензии истёк 31.10. Новые смены открываются до 14.11.2027 включительно.",
    ],
    [
      RESTRICTED,
      "Ограничена: новые смены не открываются",
      "mk-alert--error",
      "Новые смены не открываются с 15.11.2027.",
    ],
    [
      TRIAL_EXPIRED,
      "Пробный период закончился: новые смены не открываются",
      "mk-alert--error",
      "Новые смены не открываются с 24.10.2026.",
    ],
    [
      WRONG_HOST,
      "Выдана другому хосту",
      "mk-alert--warn",
      "Всё работает до 19.11.2026 включительно; затем новые смены не будут открываться.",
    ],
  ] as const)(
    "says each state in words, with a tone and its term (%#)",
    async (license, word, tone, term) => {
      const card = await openLicense(sessionWith(license));
      const state = stateOf(card);
      expect(state.classList.contains(tone)).toBe(true);
      expect(within(state).getByText(word)).toBeTruthy();
      expect(within(state).getByText(term)).toBeTruthy();
    },
  );

  it.each([
    [EXPIRING, true],
    [GRACE, true],
    [RESTRICTED, true],
    [WRONG_HOST, false],
    [INN_MISMATCH, false],
    [TRIAL, false],
    [TRIAL_EXPIRED, false],
    [DEMO, false],
  ] as const)(
    "says a new file is free for a subscription file, never for the trial or a demo (%#)",
    async (license, free) => {
      const card = await openLicense(sessionWith(license));
      expect(within(stateOf(card)).queryByText(FREE_RENEWAL) !== null).toBe(free);
      expect(within(card).queryAllByText(FREE_RENEWAL)).toHaveLength(free ? 1 : 0);
    },
  );

  it("explains an INN that no longer matches, with both numbers", async () => {
    const card = await openLicense(sessionWith(INN_MISMATCH));
    expect(
      within(card).getByText(
        "ИНН организации (7802000015) больше не совпадает с ИНН лицензии (7707083893). Новые смены не открываются. Верните ИНН в «Профиле организации» или загрузите файл лицензии для нового ИНН.",
      ),
    ).toBeTruthy();
    expect(described(card, "ИНН организации в программе")).toBe("7802000015 — не совпадает");
  });

  it("says in words, not only in colour, that more seats are used than the license gives", async () => {
    const over = licenseOf({
      quotas: { ...ACTIVE_LICENSE.quotas, stations: { limit: 3, used: 5, over: true } },
    });
    const card = await openLicense(sessionWith(over));
    const table = within(card).getByRole("region", { name: "Рабочие места" });
    expect(rowsOf(table)[0]).toEqual([
      "Станции и ТСД",
      "5",
      "3",
      "превышено: новые не подключатся",
    ]);
    expect(within(card).getByText(/новые не подключатся, пока лишние не отозваны/)).toBeTruthy();
  });

  it("writes «без ограничения» for a quota without a limit", async () => {
    const card = await openLicense(sessionWith(TRIAL));
    expect(rowsOf(within(card).getByRole("region", { name: "Рабочие места" }))[0]).toEqual([
      "Станции и ТСД",
      "1",
      "без ограничения",
      "в пределах лицензии",
    ]);
    expect(described(card, "Файл лицензии")).toBe("файл лицензии не загружен");
  });

  it("asks for the organization's INN when the site has none", async () => {
    const card = await openLicense(
      sessionWith(
        licenseOf({ binding: { ...ACTIVE_LICENSE.binding, orgInn: null, innMatches: null } }),
      ),
    );
    expect(within(card).getByText(/Укажите ИНН организации в «Профиле организации»/)).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: "Открыть «Профиль организации»" })
        .getAttribute("href"),
    ).toBe("/org");
    expect(described(card, "ИНН организации в программе")).toBe("не указан");
  });

  it("shows the technologist everything but the actions", async () => {
    const card = await openLicense(sessionWith(ACTIVE_LICENSE, { technologist: true }));
    expect(within(stateOf(card)).getByText("Действует")).toBeTruthy();
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Скопировать идентификатор хоста"]);
    expect(within(card).getByText(/может администратор/)).toBeTruthy();
  });

  it.each([
    [
      "names a zone this PC lacks",
      (session: FakeOfficeSession) =>
        session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Mars/Olympus_Mons" }),
      "Часовой пояс организации неизвестен этому компьютеру: время указано по его часам.",
    ],
    [
      "does not load",
      (session: FakeOfficeSession) => session.api.getOrg.mockRejectedValue(new Error("down")),
      "Профиль организации не загрузился: время указано по часам этого компьютера.",
    ],
  ] as const)(
    "says the dates are this PC's when the organization's profile %s, as «Резервные копии»",
    async (_, arrange, note) => {
      const session = sessionWith();
      arrange(session);
      const card = await openLicense(session);
      expect(within(card).getByText(note)).toBeTruthy();
    },
  );

  it("names each part of the card by its own heading, not by a copy of its words", async () => {
    const card = await openLicense(sessionWith());
    for (const name of ["Рабочие места", "Возможности", "Организация и привязка"]) {
      const region = within(card).getByRole("region", { name });
      expect(region.getAttribute("aria-label")).toBeNull();
      const heading = document.getElementById(region.getAttribute("aria-labelledby") ?? "");
      expect(heading?.tagName).toBe("H3");
      expect(heading?.textContent).toBe(name);
    }
  });

  it("names «было → станет» by its own heading too", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const region = await within(card).findByRole("region", { name: "Было → станет" });
    expect(region.getAttribute("aria-label")).toBeNull();
    expect(document.getElementById(region.getAttribute("aria-labelledby") ?? "")?.tagName).toBe(
      "H4",
    );
  });

  it("says nothing of the zone when the dates are the organization's", async () => {
    const card = await openLicense(sessionWith());
    expect(within(card).queryByText(/время указано по/)).toBeNull();
  });

  it("copies the host's id whole, and says so", async () => {
    const card = await openLicense(sessionWith());
    fireEvent.click(within(card).getByRole("button", { name: "Скопировать идентификатор хоста" }));
    expect(await within(card).findByText("Идентификатор хоста скопирован.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(HOST_ID);
  });

  it("keeps the checked file and an open dialog when a re-read of the license fails", async () => {
    const session = sessionWith(RESTRICTED);
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    const files = fakeOfficeFiles();
    const view = renderOffice(session, { files, hostRevision: 1, initialPath: "/about" });
    const card = await licenseCard();
    pick(card, new File([FILE_TEXT], "site.mklic"));
    await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    await screen.findByRole("dialog");
    const reads = session.api.getLicense.mock.calls.length;
    // A new revision reads the license again (`Office`), and the host does not answer it.
    session.api.getLicense.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office
          session={session}
          labels={quietLabelRendering()}
          files={files}
          hostRevision={2}
          initialPath="/about"
        />
      </ThemeProvider>,
    );
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalledTimes(reads + 1));
    // The failure says so above the last answer, which stays with what the person was doing.
    expect(await within(card).findByRole("button", { name: "Повторить" })).toBeTruthy();
    expect(within(card).getByRole("region", { name: "Было → станет" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(stateOf(card)).getByText("Ограничена: новые смены не открываются")).toBeTruthy();
  });

  it("explains a host that does not answer in the section alone, and reads again", async () => {
    const session = sessionWith();
    // Every read fails until the retry: the band and «Обзор» (task 7) read the same license.
    session.api.getLicense.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const card = await openLicense(session);
    expect(screen.getByRole("heading", { name: "Контакты и поддержка", level: 2 })).toBeTruthy();
    session.api.getLicense.mockResolvedValue(ACTIVE_LICENSE);
    fireEvent.click(within(card).getByRole("button", { name: "Повторить" }));
    expect(await within(card).findByText("Действует")).toBeTruthy();
  });
});

/** The terms of `license`'s file, as the preview answers them. */
function termsOf(license: OfficeLicense): LicenseTerms {
  const file = license.license;
  if (file === null) throw new Error("the fixture has a file");
  return {
    licenseId: file.licenseId,
    sequence: file.sequence,
    plan: file.plan,
    validFrom: file.validFrom,
    validUntil: file.validUntil,
    graceDays: file.graceDays,
    quotas: license.quotas,
    features: license.features,
  };
}

/** The next file: a year more and 8 stations. */
function upgradePreview(): LicensePreview {
  const before = termsOf(ACTIVE_LICENSE);
  return {
    before,
    after: {
      ...before,
      licenseId: "9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a",
      sequence: 4,
      validUntil: "2028-10-31T21:00:00Z",
      quotas: { ...before.quotas, stations: { limit: 8, used: 3, over: false } },
    },
    changes: ["validUntil", "quotas.stations"],
    warnings: [],
  };
}

const UPGRADED = licenseOf({
  license: { ...ACTIVE_LICENSE.license!, sequence: 4, validUntil: "2028-10-31T21:00:00Z" },
  quotas: { ...ACTIVE_LICENSE.quotas, stations: { limit: 8, used: 3, over: false } },
});

function pick(card: HTMLElement, file: File): void {
  fireEvent.change(within(card).getByTestId("file-drop-input"), { target: { files: [file] } });
}

const FILE_TEXT = "eyJ0eXAiOiJtYXJraXJvIn0.eyJ2ZXJzaW9uIjoxfQ.c2ln";

describe("loading a license file", () => {
  it("checks the file first, shows «было → станет», then loads it and says till when it runs", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    session.api.loadLicense.mockResolvedValue(UPGRADED);
    const card = await openLicense(session);
    pick(card, new File([`${FILE_TEXT}\n`], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    expect(session.api.previewLicense.mock.calls[0]?.[1]).toEqual({ file: FILE_TEXT });
    expect(session.api.loadLicense).not.toHaveBeenCalled();
    const stations = rowsOf(preview).find((row) => row[0] === "Станции и ТСД");
    expect(stations).toEqual(["Станции и ТСД", "5", "8 (изменится)"]);
    fireEvent.click(within(preview).getByRole("button", { name: "Загрузить" }));
    expect(
      await within(card).findByText("Лицензия загружена. Действует по 31.10.2028 включительно."),
    ).toBeTruthy();
    expect(session.api.loadLicense.mock.calls[0]?.[1]).toEqual({ file: FILE_TEXT });
    expect(within(card).queryByRole("region", { name: "Было → станет" })).toBeNull();
    expect(within(card).getByText("Действует по 31.10.2028 включительно.")).toBeTruthy();
  });

  it("warns before loading a file that leaves more devices than it gives", async () => {
    const session = sessionWith();
    const upgrade = upgradePreview();
    session.api.previewLicense.mockResolvedValue({
      ...upgrade,
      after: {
        ...upgrade.after,
        quotas: { ...upgrade.after.quotas, stations: { limit: 2, used: 3, over: true } },
      },
      warnings: ["over_limit"],
    });
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    expect(
      await within(card).findByText(
        "Станции и ТСД: будет использовано 3 из 2. Новые устройства не подключатся, работающие продолжат.",
      ),
    ).toBeTruthy();
  });

  it("warns before loading a file whose term has already ended", async () => {
    const session = sessionWith();
    const upgrade = upgradePreview();
    session.api.previewLicense.mockResolvedValue({
      ...upgrade,
      after: { ...upgrade.after, validUntil: "2026-09-30T21:00:00Z" },
      warnings: ["expired"],
    });
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    expect(
      within(preview).getByText(
        "Срок этого файла уже истёк 30.09.2026: после загрузки новые смены открываться не будут.",
      ),
    ).toBeTruthy();
  });

  it("checks and loads the file picked last", async () => {
    const session = sessionWith();
    const upgrade = upgradePreview();
    session.api.previewLicense.mockImplementation((_token, request) =>
      Promise.resolve(
        request.file === "second"
          ? { ...upgrade, after: { ...upgrade.after, sequence: 5 } }
          : upgrade,
      ),
    );
    session.api.loadLicense.mockResolvedValue(UPGRADED);
    const card = await openLicense(session);
    pick(card, new File(["first"], "first.mklic"));
    await within(card).findByRole("region", { name: "Было → станет" });
    pick(card, new File(["second"], "second.mklic"));
    await waitFor(() => expect(session.api.previewLicense).toHaveBeenCalledTimes(2));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(preview).getByRole("button", { name: "Загрузить" }));
    await within(card).findByText(/Лицензия загружена/);
    expect(session.api.loadLicense.mock.calls.map((call) => call[1])).toEqual([{ file: "second" }]);
  });

  it("forgets a file still being read once another is picked", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    session.api.loadLicense.mockResolvedValue(UPGRADED);
    const card = await openLicense(session);
    let finishFirst: (text: string) => void = () => undefined;
    const slow = new File(["first"], "first.mklic");
    Object.defineProperty(slow, "text", {
      value: () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    });
    pick(card, slow);
    pick(card, new File(["second"], "second.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    finishFirst("first");
    fireEvent.click(within(preview).getByRole("button", { name: "Загрузить" }));
    await within(card).findByText(/Лицензия загружена/);
    expect(session.api.previewLicense.mock.calls.map((call) => call[1])).toEqual([
      { file: "second" },
    ]);
    expect(session.api.loadLicense.mock.calls.map((call) => call[1])).toEqual([{ file: "second" }]);
  });

  it("drops the checked file on «Отмена» and loads nothing", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(preview).getByRole("button", { name: "Отмена" }));
    expect(within(card).queryByRole("region", { name: "Было → станет" })).toBeNull();
    expect(session.api.loadLicense).not.toHaveBeenCalled();
  });

  it("explains a refused file and moves the focus to the explanation", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "x",
        details: { field: "file", reason: "license_signature" },
      }),
    );
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const text = await within(card).findByText(
      "Подпись файла не сходится: файл изменён после выпуска. Запросите файл заново.",
    );
    await waitFor(() => expect(document.activeElement?.contains(text)).toBe(true));
    expect(within(card).queryByRole("region", { name: "Было → станет" })).toBeNull();
  });

  it("refuses a file over 16 KiB and one of another type without asking the host", async () => {
    const session = sessionWith();
    const card = await openLicense(session);
    pick(card, new File(["a".repeat(16 * 1024 + 1)], "site.mklic"));
    expect(
      await within(card).findByText("Файл больше 16 КиБ: это не файл лицензии Маркиро."),
    ).toBeTruthy();
    pick(card, new File([FILE_TEXT], "site.txt"));
    expect(await within(card).findByText("Нужен файл лицензии с расширением .mklic.")).toBeTruthy();
    expect(session.api.previewLicense).not.toHaveBeenCalled();
  });

  it("sends a double click on «Загрузить» once", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    let answer: (license: OfficeLicense) => void = () => undefined;
    session.api.loadLicense.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    const load = within(preview).getByRole("button", { name: "Загрузить" });
    fireEvent.click(load);
    fireEvent.click(load);
    // The office's call reaches the host a tick later: answer only the request that went out.
    await waitFor(() => expect(session.api.loadLicense).toHaveBeenCalled());
    fireEvent.click(load);
    answer(UPGRADED);
    await within(card).findByText(/Лицензия загружена/);
    expect(session.api.loadLicense).toHaveBeenCalledTimes(1);
  });

  it("keeps no copy of the file's text in the office's cache once it is loaded", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    session.api.loadLicense.mockResolvedValue(UPGRADED);
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(preview).getByRole("button", { name: "Загрузить" }));
    await within(card).findByText(/Лицензия загружена/);
    await waitFor(() => expect(heldWith(FILE_TEXT)).toEqual([]));
  });

  it("keeps no copy of the file's text in the office's cache after «Отмена»", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(preview).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(heldWith(FILE_TEXT)).toEqual([]));
  });

  it("keeps no copy of the file's text in the office's cache after a refusal", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    session.api.loadLicense.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(preview).getByRole("button", { name: "Загрузить" }));
    await waitFor(() => expect(session.api.loadLicense).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(heldWith(FILE_TEXT)).toEqual([]));
  });

  it("offers no file to the technologist", async () => {
    const card = await openLicense(sessionWith(ACTIVE_LICENSE, { technologist: true }));
    expect(within(card).queryByTestId("file-drop-input")).toBeNull();
  });

  it("offers no file before the organization has an INN", async () => {
    const card = await openLicense(
      sessionWith(
        licenseOf({ binding: { ...ACTIVE_LICENSE.binding, orgInn: null, innMatches: null } }),
      ),
    );
    expect(within(card).getByTestId("file-drop-input")).toHaveProperty("disabled", true);
  });
});

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const ACTIVATION_REQUEST = standaloneActivationRequestSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/domain/fixtures/standalone-license/activation-request.json",
        testModuleUrl,
      ),
      "utf8",
    ),
  ),
);

describe("the activation request and the emergency extension", () => {
  it.each(["statistics unavailable", "no key"])(
    "warns when the saved request has no usage statistics: %s",
    async (reason) => {
      const key =
        reason === "no key"
          ? vi.spyOn(SupportKeys, "activeSupportKey").mockReturnValue(null)
          : null;
      try {
        const session = sessionWith();
        session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
        const files = fakeOfficeFiles();
        const card = await openLicense(session, files);
        fireEvent.click(
          within(card).getByRole("button", { name: "Сохранить запрос на активацию" }),
        );
        expect(
          await within(card).findByText(
            "Запрос сохранён без статистики использования. Для обновления статистики сформируйте новый запрос, когда сведения станут доступны.",
          ),
        ).toBeTruthy();
        const saved = files.save.mock.calls[0]?.[1][0];
        expect(
          saved === undefined ? null : JSON.parse(new TextDecoder().decode(saved.bytes)),
        ).toEqual(ACTIVATION_REQUEST);
      } finally {
        key?.mockRestore();
      }
    },
  );

  it("includes encrypted usage statistics in a normal build without showing the fallback warning", async () => {
    const session = sessionWith();
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    session.api.getUsageStats.mockResolvedValue(
      usageStatsSchema.parse(
        JSON.parse(
          readFileSync(new URL("../proto/fixtures/usage-stats.json", testModuleUrl), "utf8"),
        ),
      ),
    );
    const files = fakeOfficeFiles();
    const card = await openLicense(session, files);
    fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
    expect(await within(card).findByText(/^Запрос сохранён в папке /)).toBeTruthy();
    const saved = files.save.mock.calls[0]?.[1][0];
    expect(
      saved === undefined ? null : JSON.parse(new TextDecoder().decode(saved.bytes)),
    ).toMatchObject({
      ...ACTIVATION_REQUEST,
      supportToken: expect.stringMatching(/^MKS1\.sup-d11c3182\./),
    });
    expect(within(card).queryByText(/^Запрос сохранён без статистики/)).toBeNull();
  });

  it("saves the host's activation request as JSON under «Лицензия» and shows the folder", async () => {
    const session = sessionWith(WRONG_HOST);
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    const files = fakeOfficeFiles();
    const card = await openLicense(session, files);
    fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
    expect(await within(card).findByText(/^Запрос сохранён в папке /)).toBeTruthy();
    expect(files.save).toHaveBeenCalledTimes(1);
    const [segments, saved] = files.save.mock.calls[0]!;
    expect(segments[0]).toBe("Лицензия");
    expect(segments[1]).toMatch(/^Запрос на активацию \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(saved.map((file) => file.name)).toEqual(["markiro-activation-request.json"]);
    expect(JSON.parse(new TextDecoder().decode(saved[0]!.bytes))).toEqual(ACTIVATION_REQUEST);
    expect(
      within(card).getByText(
        `Запрос сохранён в папке C:\\Users\\Оператор\\Documents\\Markiro\\${segments.join("\\")}. Отправьте файл в Маркиро.`,
      ),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Показать папку" }));
    expect(files.open).toHaveBeenCalledWith(segments);
  });

  it.each([
    ["saved", null],
    ["not saved", new OfficeFilesError("storage", "disk full")],
  ] as const)(
    "keeps no copy of the activation request in the office's cache once it is %s",
    async (_, failure) => {
      const session = sessionWith();
      session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
      const files = fakeOfficeFiles();
      if (failure !== null) files.save.mockRejectedValue(failure);
      const card = await openLicense(session, files);
      fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
      await within(card).findByText(
        failure === null ? /^Запрос сохранён в папке / : /Не удалось сохранить/,
      );
      await waitFor(() => expect(heldWith(ACTIVATION_REQUEST.organization.name)).toEqual([]));
    },
  );

  it("says when the request could not be saved", async () => {
    const session = sessionWith();
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("storage", "disk full"));
    const card = await openLicense(session, files);
    fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
    expect(await within(card).findByText(/Не удалось сохранить запрос/)).toBeTruthy();
  });

  it("opens new shifts for 3 more days once, after asking, till the host's time plus 72 hours", async () => {
    const session = sessionWith(RESTRICTED);
    session.api.enableLicenseEmergency.mockResolvedValue({
      ...RESTRICTED,
      // The host's answer: the extension runs, so new shifts open (ЛЦ-2).
      opensNewShifts: true,
      emergency: { available: false, until: "2027-11-23T06:00:00Z" },
    });
    const card = await openLicense(session);
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Открывать новые смены ещё 3 дня, до 23.11 09:00? Это можно сделать один раз для каждой лицензии.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть на 3 дня" }));
    expect(await within(card).findByText("Новые смены открываются до 23.11 09:00.")).toBeTruthy();
    expect(session.api.enableLicenseEmergency).toHaveBeenCalledTimes(1);
    expect(
      within(card).getByText("Аварийное продление: новые смены открываются до 23.11 09:00."),
    ).toBeTruthy();
    expect(
      within(card).getByText("Ограничена: новые смены открываются по аварийному продлению"),
    ).toBeTruthy();
    expect(within(card).queryByText(/не открываются/)).toBeNull();
    expect(
      within(card).queryByRole("button", { name: "Открыть новые смены ещё 3 дня" }),
    ).toBeNull();
  });

  it("says the extension was already used for this license", async () => {
    const session = sessionWith(TRIAL_EXPIRED);
    session.api.enableLicenseEmergency.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "used",
        details: { constraint: "emergency_used" },
      }),
    );
    const card = await openLicense(session);
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть на 3 дня" }));
    expect(
      await within(dialog).findByText("Аварийное продление для этой лицензии уже использовано."),
    ).toBeTruthy();
  });

  it.each([
    ["a valid license", ACTIVE_LICENSE],
    ["the grace", GRACE],
    [
      "a restriction whose extension the host no longer allows",
      licenseOf({ ...RESTRICTED, emergency: { available: false, until: null } }),
    ],
  ] as const)("does not offer the extension for %s", async (_, license) => {
    const card = await openLicense(sessionWith(license));
    expect(
      within(card).queryByRole("button", { name: "Открыть новые смены ещё 3 дня" }),
    ).toBeNull();
  });

  it("sends a double click on «Сохранить запрос на активацию» once", async () => {
    const session = sessionWith();
    let answer: (request: typeof ACTIVATION_REQUEST) => void = () => undefined;
    session.api.getActivationRequest.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const files = fakeOfficeFiles();
    const card = await openLicense(session, files);
    const button = within(card).getByRole("button", { name: "Сохранить запрос на активацию" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(session.api.getActivationRequest).toHaveBeenCalled());
    fireEvent.click(button);
    answer(ACTIVATION_REQUEST);
    expect(await within(card).findByText(/^Запрос сохранён в папке /)).toBeTruthy();
    expect(session.api.getActivationRequest).toHaveBeenCalledTimes(1);
    expect(files.save).toHaveBeenCalledTimes(1);
  });

  it("drops the saved request's message with the next action", async () => {
    const session = sessionWith(RESTRICTED);
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    const card = await openLicense(session);
    fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
    expect(await within(card).findByText(/^Запрос сохранён в папке /)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    await screen.findByRole("dialog");
    expect(within(card).queryByText(/^Запрос сохранён в папке /)).toBeNull();
  });

  it("offers the extension under an INN mismatch when the host allows it (spec §19)", async () => {
    const card = await openLicense(sessionWith(INN_MISMATCH));
    expect(
      within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }),
    ).toBeTruthy();
  });

  it("says the extension is not needed when new shifts open anyway", async () => {
    const session = sessionWith(RESTRICTED);
    session.api.enableLicenseEmergency.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "not needed",
        details: { constraint: "emergency_not_needed" },
      }),
    );
    const card = await openLicense(session);
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть на 3 дня" }));
    expect(
      await within(dialog).findByText(
        "Аварийное продление не нужно: новые смены и так открываются.",
      ),
    ).toBeTruthy();
  });

  it.each(["emergency_used", "emergency_not_needed"])(
    "reads the license again when the host refuses the extension as %s",
    async (constraint) => {
      const session = sessionWith(RESTRICTED);
      session.api.enableLicenseEmergency.mockRejectedValue(
        new HostError({
          kind: "api",
          code: "conflict",
          status: 409,
          message: "refused",
          details: { constraint },
        }),
      );
      const card = await openLicense(session);
      fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
      const dialog = await screen.findByRole("dialog");
      // The host's state has moved on under the page: the extension is no longer offered.
      session.api.getLicense.mockResolvedValue(
        licenseOf({ ...RESTRICTED, emergency: { available: false, until: null } }),
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Открыть на 3 дня" }));
      await within(dialog).findByText(/^Аварийное продление/);
      await waitFor(() =>
        expect(
          within(card).queryByRole("button", {
            name: "Открыть новые смены ещё 3 дня",
            hidden: true,
          }),
        ).toBeNull(),
      );
    },
  );

  it("asks with the host's time read afresh, not the time the page was opened at", async () => {
    const session = sessionWith(RESTRICTED);
    const card = await openLicense(session);
    // A day later by the host's clock: the extension would end a day later too.
    session.api.getLicense.mockResolvedValue(
      licenseOf({ ...RESTRICTED, effectiveAt: "2027-11-21T06:00:00Z" }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/^Открывать новые смены ещё 3 дня, до 24\.11 09:00\?/),
    ).toBeTruthy();
  });

  it("asks with the last known time when the host does not answer the fresh read", async () => {
    const session = sessionWith(RESTRICTED);
    const card = await openLicense(session);
    const reads = session.api.getLicense.mock.calls.length;
    session.api.getLicense.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/^Открывать новые смены ещё 3 дня, до 23\.11 09:00\?/),
    ).toBeTruthy();
    expect(session.api.getLicense.mock.calls.length).toBe(reads + 1);
  });

  it("stays busy while the request is saved, not only while it is fetched", async () => {
    const session = sessionWith();
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    const files = fakeOfficeFiles();
    let finish: () => void = () => undefined;
    files.save.mockImplementation(
      (segments, saved) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              segments: [...segments],
              path: `C:\\Markiro\\${segments.join("\\")}`,
              files: saved.map((file) => file.name),
            });
        }),
    );
    const card = await openLicense(session, files);
    const button = within(card).getByRole("button", { name: "Сохранить запрос на активацию" });
    fireEvent.click(button);
    await waitFor(() => expect(files.save).toHaveBeenCalledTimes(1));
    expect(button).toHaveProperty("disabled", true);
    finish();
    await within(card).findByText(/^Запрос сохранён в папке /);
    expect(button).toHaveProperty("disabled", false);
  });

  it("offers the technologist neither the extension nor the request", async () => {
    const tech = await openLicense(sessionWith(RESTRICTED, { technologist: true }));
    expect(
      within(tech).queryByRole("button", { name: "Открыть новые смены ещё 3 дня" }),
    ).toBeNull();
    expect(
      within(tech).queryByRole("button", { name: "Сохранить запрос на активацию" }),
    ).toBeNull();
  });

  it("shows the switched-off custom logo as locked: a lock, the reason on the page, and the same reason on hover and focus", async () => {
    const license = licenseOf({ features: { ...ACTIVE_LICENSE.features, customLogo: false } });
    const card = await openLicense(sessionWith(license));
    const row = within(card).getByText("Логотип организации на формах и этикетках").closest("li");
    if (row === null) throw new Error("no feature row");
    const reason =
      "Загрузка логотипа требует отдельной лицензии. Загруженный ранее логотип остаётся и печатается как раньше.";
    // A lock and the word «выключено», and the reason in the row itself, not in the tooltip alone.
    expect(row.querySelector("svg")).not.toBeNull();
    expect(within(row).getByText("выключено")).toBeTruthy();
    expect(within(row).getAllByText(reason)).toHaveLength(1);
    // The tooltip repeats it for hover and for the keyboard.
    const state = row.querySelector(".license-features__state");
    if (!(state instanceof HTMLElement)) throw new Error("no state");
    expect(state.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(state);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toBe(reason);
    // The features that are on carry no lock and no reason.
    const other = within(card).getByText("Открытый API").closest("li");
    expect(other?.querySelector("svg")).toBeNull();
  });
});
