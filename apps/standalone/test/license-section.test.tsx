import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeLicense } from "../src/host/protocol.js";
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
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const writeText = vi.fn<(text: string) => Promise<void>>();

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
      ["Паллеты", "включено"],
      ["Обмен с Честным ЗНАКом", "включено"],
      ["Инвентаризация", "выключено"],
      ["Обмен с 1С (CommerceML)", "выключено"],
      ["ТСД", "включено"],
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
    [TRIAL, "Пробный период", "mk-alert--info", "Пробный период до 24.10.2026 включительно."],
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

  it("copies the host's id whole, and says so", async () => {
    const card = await openLicense(sessionWith());
    fireEvent.click(within(card).getByRole("button", { name: "Скопировать идентификатор хоста" }));
    expect(await within(card).findByText("Идентификатор хоста скопирован.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(HOST_ID);
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
