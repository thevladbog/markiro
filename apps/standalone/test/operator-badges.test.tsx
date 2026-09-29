import { readFileSync } from "node:fs";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { verifyPhc } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { BadgeInfo, BadgeSalt, OfficeOperator } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./support/office.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
}

/** `badge-salt.json` and `badge-create.json`: «MRK-000742» hashed with the site's salt. */
const SITE_SALT = String(fixture("badge-salt.json").badgeSalt);
const BADGE_PHC = String(fixture("badge-create.json").badgePhc);

const REVOKED: BadgeInfo = {
  id: "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
  label: null,
  createdAt: "2026-09-20T08:00:00Z",
  revokedAt: "2026-09-27T08:00:00Z",
};
const PASS_7: BadgeInfo = {
  id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
  label: "Пропуск №7",
  createdAt: "2026-09-27T08:00:00Z",
  revokedAt: null,
};
const ANNA: OfficeOperator = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
  active: true,
  hasPin: true,
  badges: [REVOKED, PASS_7],
  rev: 55,
};
const VERA: OfficeOperator = {
  id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  login: "99",
  name: "Вера Лебедева",
  role: null,
  active: true,
  hasPin: true,
  badges: [],
  rev: 41,
};
const PASS_8: BadgeInfo = {
  id: "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b",
  label: "Пропуск №8",
  createdAt: "2026-09-28T08:00:00Z",
  revokedAt: null,
};

const DATE = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short" });

function day(at: string): string {
  return DATE.format(new Date(at));
}

function badgeTaken(operatorId: unknown): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: "this badge already belongs to an operator",
    details: { constraint: "badge", operatorId },
  });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listOperators.mockResolvedValue([ANNA, VERA]);
  session.api.getBadgeSalt.mockResolvedValue({ badgeSalt: SITE_SALT });
  return session;
}

/** The operators page with Анна's badges open. */
async function openBadges(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Операторы" }));
  fireEvent.click(await screen.findByRole("button", { name: "Бейджи оператора «Анна Кузнецова»" }));
  await screen.findByRole("dialog", { name: "Бейджи оператора «Анна Кузнецова»" });
}

/** The add dialog over Анна's badges, once the salt is read. */
async function openAdd(session: FakeOfficeSession): Promise<void> {
  await openBadges(session);
  fireEvent.click(screen.getByRole("button", { name: "Добавить бейдж" }));
  await screen.findByRole("dialog", { name: "Новый бейдж: Анна Кузнецова" });
  await waitFor(() =>
    expect(within(dialog()).getByRole("button", { name: "Добавить" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function itemOf(label: string): HTMLElement {
  const item = within(dialog()).getByText(label).closest("li");
  if (!item) throw new Error(`no badge ${label}`);
  return item;
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function codeField(): HTMLInputElement {
  const field = screen.getByLabelText("Код бейджа");
  if (!(field instanceof HTMLInputElement)) throw new Error("the code field is not an input");
  return field;
}

/** The scanner's Enter: submits the form the field is in. */
function pressEnter(field: HTMLElement): void {
  const form = field.closest("form");
  if (!form) throw new Error("the code field is not in a form");
  fireEvent.submit(form);
}

/** What a keyboard-wedge scanner does: type the code, then Enter submits the form. */
function scan(code: string): void {
  const field = codeField();
  fireEvent.change(field, { target: { value: code } });
  pressEnter(field);
}

/**
 * What a wedge really does: it types after whatever the field already holds,
 * which nobody can see, because the field is masked, and then presses Enter.
 * `scan` replaces the value instead, and so cannot show a scan glued to an
 * earlier one.
 */
function wedge(text: string): void {
  const field = codeField();
  fireEvent.change(field, { target: { value: field.value + text } });
  pressEnter(field);
}

/** The hash the `call`th `createBadge` request carried. */
function sentHash(session: FakeOfficeSession, call: number): string {
  const body = session.api.createBadge.mock.calls[call]?.[2];
  if (!body) throw new Error(`no createBadge call ${call}`);
  return body.badgePhc;
}

/**
 * What can fail a badge's code once the form has accepted it, and the text then
 * shown: the host's refusals of the code, under the field, and a request that
 * fails, in the alert above the form.
 */
const CODE_FAILURES: [name: string, failure: HostError, message: string][] = [
  [
    "names the operator who holds it",
    badgeTaken(VERA.id),
    "Этот бейдж уже у оператора «Вера Лебедева»",
  ],
  ["does not know who holds it", badgeTaken(undefined), "Этот бейдж уже выдан оператору"],
  [
    "refuses its hash",
    new HostError({
      kind: "api",
      code: "validation_failed",
      status: 422,
      message: "the badge hash is not valid",
      details: { field: "badgePhc" },
    }),
    "Хост не принял это значение. Проверьте его.",
  ],
  [
    "cannot be reached",
    new HostError({ kind: "transport", code: "unreachable", message: "no answer" }),
    "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
  ],
];

describe("operator badges", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lists an operator's badges, revoked ones too, dimmed and in words", async () => {
    await openBadges(adminSession());
    const revoked = itemOf("Без подписи");
    expect(within(revoked).getByText("Отозван")).toBeTruthy();
    expect(within(revoked).getByText(`Добавлен ${day(REVOKED.createdAt)}`)).toBeTruthy();
    expect(revoked.className).toContain("badge-list__item--revoked");
    expect(within(revoked).queryByRole("button")).toBeNull();
    const pass = itemOf("Пропуск №7");
    expect(within(pass).getByText("Действует")).toBeTruthy();
    expect(pass.className).not.toContain("badge-list__item--revoked");
    expect(
      within(pass).getByRole("button", {
        name: `Отозвать бейдж «Пропуск №7», добавленный ${day(PASS_7.createdAt)}`,
      }),
    ).toBeTruthy();
  });

  it("adds a scanned badge: the trimmed code hashed with the site's salt, never the code", async () => {
    const session = adminSession();
    session.api.createBadge.mockResolvedValue(PASS_8);
    await openAdd(session);
    // The code field takes the focus, ready for the scanner.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Код бейджа")));
    type("Подпись", " Пропуск №8 ");
    scan(" MRK-000742 ");
    await waitFor(() => expect(session.api.createBadge).toHaveBeenCalledTimes(1));
    expect(session.api.createBadge.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { badgePhc: BADGE_PHC, label: "Пропуск №8" }],
    ]);
    // Back to the list, with the new badge in it and on the page's row at once.
    expect(await screen.findByText("Бейдж «Пропуск №8» добавлен.")).toBeTruthy();
    expect(within(itemOf("Пропуск №8")).getByText("Действует")).toBeTruthy();
    expect(within(rowOf("Анна Кузнецова")).getByText("2 — Пропуск №7, Пропуск №8")).toBeTruthy();
    expect(session.api.listOperators).toHaveBeenCalledTimes(1);
  });

  it("reads the site's salt once and reuses it when the dialog is opened again soon", async () => {
    const session = adminSession();
    await openAdd(session);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(await screen.findByRole("button", { name: "Добавить бейдж" }));
    await screen.findByText("Новый бейдж: Анна Кузнецова");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.getBadgeSalt).toHaveBeenCalledTimes(1);
  });

  it("refuses a code typed under the Russian layout before hashing or sending", async () => {
    const session = adminSession();
    await openAdd(session);
    scan("ЬКЛ-000742");
    expect(
      await screen.findByText("Код набран русскими буквами — переключите раскладку на английскую"),
    ).toBeTruthy();
    expect(session.api.createBadge).not.toHaveBeenCalled();
  });

  it("names the operator who already holds the badge, under the code", async () => {
    const session = adminSession();
    session.api.createBadge.mockRejectedValueOnce(badgeTaken(VERA.id));
    await openAdd(session);
    scan("MRK-000742");
    const message = await screen.findByText("Этот бейдж уже у оператора «Вера Лебедева»");
    expect(screen.getByLabelText("Код бейджа").getAttribute("aria-describedby")).toBe(message.id);
    expect(screen.getByText("Новый бейдж: Анна Кузнецова")).toBeTruthy();
  });

  it.each([
    ["an id that is not a UUID", "8a3c1f0e"],
    ["an operator the list does not know", "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f"],
    ["no id at all", undefined],
  ])("says the badge is taken when the conflict names %s", async (_case, operatorId) => {
    const session = adminSession();
    session.api.createBadge.mockRejectedValueOnce(badgeTaken(operatorId));
    await openAdd(session);
    scan("MRK-000742");
    expect(await screen.findByText("Этот бейдж уже выдан оператору")).toBeTruthy();
  });

  it("empties the masked code after the layout refusal, so the next scan is not glued to it", async () => {
    const session = adminSession();
    session.api.createBadge.mockResolvedValue(PASS_8);
    await openAdd(session);
    wedge("ЬКЛ-000742");
    const refusal = "Код набран русскими буквами — переключите раскладку на английскую";
    expect(await screen.findByText(refusal)).toBeTruthy();
    // Nobody can see or correct a masked field: the refused code goes, the focus
    // is on the field for the next scan, and the message stays until it is typed.
    await waitFor(() => {
      expect(codeField().value).toBe("");
      expect(document.activeElement).toBe(codeField());
    });
    expect(screen.getByText(refusal)).toBeTruthy();
    expect(session.api.createBadge).not.toHaveBeenCalled();
    wedge("MRK-000742");
    await waitFor(() => expect(session.api.createBadge).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Бейдж «Пропуск №8» добавлен.")).toBeTruthy();
    // The hash of the second scan alone, not of «ЬКЛ-000742MRK-000742».
    expect(session.api.createBadge.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { badgePhc: BADGE_PHC, label: null }],
    ]);
  });

  it.each(CODE_FAILURES)(
    "empties the masked code when the host %s, so the next scan is not glued to it",
    async (_case, failure, message) => {
      const session = adminSession();
      session.api.createBadge.mockRejectedValueOnce(failure).mockResolvedValueOnce(PASS_8);
      await openAdd(session);
      await waitFor(() => expect(document.activeElement).toBe(codeField()));
      // A person who pressed «Добавить» has the focus on the button, not on the field.
      act(() => within(dialog()).getByRole("button", { name: "Добавить" }).focus());
      wedge("MRK-000742");
      expect(await screen.findByText(message)).toBeTruthy();
      await waitFor(() => {
        expect(codeField().value).toBe("");
        expect(document.activeElement).toBe(codeField());
      });
      expect(screen.getByText(message)).toBeTruthy();
      wedge("MRK-000743");
      await waitFor(() => expect(session.api.createBadge).toHaveBeenCalledTimes(2));
      expect(await screen.findByText("Бейдж «Пропуск №8» добавлен.")).toBeTruthy();
      // The second request hashes the second scan alone, not «MRK-000742MRK-000743»
      // (a code that passes every rule, and that no station's scan would ever match).
      await expect(verifyPhc("MRK-000743", sentHash(session, 1))).resolves.toBe(true);
    },
  );

  it("keeps the masked code when the form refuses only the label, and sends it once the label is corrected", async () => {
    const session = adminSession();
    session.api.createBadge.mockResolvedValue(PASS_8);
    await openAdd(session);
    type("Подпись", "п".repeat(101));
    wedge("MRK-000742");
    expect(await screen.findByText("Подпись — до 100 символов")).toBeTruthy();
    // The code is not what was refused: it stays as it was scanned.
    expect(codeField().value).toBe("MRK-000742");
    expect(session.api.createBadge).not.toHaveBeenCalled();
    // The label is corrected beside it and the button pressed again.
    type("Подпись", "Пропуск №8");
    pressEnter(codeField());
    await waitFor(() => expect(session.api.createBadge).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Бейдж «Пропуск №8» добавлен.")).toBeTruthy();
    expect(session.api.createBadge.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { badgePhc: BADGE_PHC, label: "Пропуск №8" }],
    ]);
  });

  it("keeps the masked code when the host refuses only the label, and shows it under the label", async () => {
    const session = adminSession();
    session.api.createBadge
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          status: 422,
          message: "the badge label is not valid",
          details: { field: "label" },
        }),
      )
      .mockResolvedValueOnce(PASS_8);
    await openAdd(session);
    type("Подпись", "Пропуск №8");
    wedge("MRK-000742");
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.getByLabelText("Подпись").getAttribute("aria-describedby")).toBe(message.id);
    // The code is not what was refused: it stays as it was scanned.
    expect(codeField().value).toBe("MRK-000742");
    // The label is corrected beside it and the button pressed again: the same scan.
    type("Подпись", "Пропуск № 8");
    pressEnter(codeField());
    await waitFor(() => expect(session.api.createBadge).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Бейдж «Пропуск №8» добавлен.")).toBeTruthy();
    expect([sentHash(session, 0), sentHash(session, 1)]).toStrictEqual([BADGE_PHC, BADGE_PHC]);
  });

  it("keeps the code field read-only until the site's salt is read", async () => {
    const session = adminSession();
    let answerSalt: (salt: BadgeSalt) => void = () => undefined;
    session.api.getBadgeSalt.mockImplementation(
      () =>
        new Promise<BadgeSalt>((resolve) => {
          answerSalt = resolve;
        }),
    );
    await openBadges(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить бейдж" }));
    await screen.findByRole("dialog", { name: "Новый бейдж: Анна Кузнецова" });
    await waitFor(() => expect(session.api.getBadgeSalt).toHaveBeenCalledTimes(1));
    // Nothing can be sent yet: a scan typed now would sit, masked, in front of the next one.
    expect(codeField().readOnly).toBe(true);
    await act(async () => {
      answerSalt({ badgeSalt: SITE_SALT });
    });
    await waitFor(() => expect(codeField().readOnly).toBe(false));
  });

  it("keeps the code field read-only when the site's salt could not be read", async () => {
    const session = adminSession();
    session.api.getBadgeSalt.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "no answer" }),
    );
    await openBadges(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить бейдж" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(codeField().readOnly).toBe(true);
  });

  it("explains a host that has no badge salt yet and keeps the form from sending", async () => {
    const session = adminSession();
    session.api.getBadgeSalt.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "not_found",
        status: 404,
        message: "the host is not initialized",
      }),
    );
    await openBadges(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить бейдж" }));
    expect(
      await screen.findByText(
        "Хост ещё не настроен: бейджи можно добавлять после первого запуска.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Добавить" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("revokes a badge after a confirmation, shows it revoked at once, then reads the list again", async () => {
    const session = adminSession();
    session.api.revokeBadge.mockResolvedValue(undefined);
    await openBadges(session);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Отозвать бейдж «Пропуск №7», добавленный ${day(PASS_7.createdAt)}`,
      }),
    );
    expect(
      within(dialog()).getByText(
        "Бейдж «Пропуск №7» оператора «Анна Кузнецова» перестанет открывать вход на станциях, как только они получат изменение. Отозванный бейдж не вернуть: для этой карты понадобится новый бейдж.",
      ),
    ).toBeTruthy();
    // The read that follows the revoke stays pending until the badge has been
    // checked: the revoke itself must already show.
    let answerRead: (operators: OfficeOperator[]) => void = () => undefined;
    session.api.listOperators.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerRead = resolve;
        }),
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Бейдж «Пропуск №7» отозван.")).toBeTruthy();
    expect(session.api.revokeBadge.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, PASS_7.id],
    ]);
    await waitFor(() => expect(session.api.listOperators).toHaveBeenCalledTimes(2));
    expect(within(itemOf("Пропуск №7")).getByText("Отозван")).toBeTruthy();
    expect(within(rowOf("Анна Кузнецова")).getByText("Нет")).toBeTruthy();
    await act(async () => {
      answerRead([
        { ...ANNA, badges: [REVOKED, { ...PASS_7, revokedAt: "2026-09-28T09:00:00Z" }] },
        VERA,
      ]);
    });
    expect(within(itemOf("Пропуск №7")).getByText("Отозван")).toBeTruthy();
  });

  it("explains a revocation the host refused, in the dialog", async () => {
    const session = adminSession();
    session.api.revokeBadge.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such badge" }),
    );
    await openBadges(session);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Отозвать бейдж «Пропуск №7», добавленный ${day(PASS_7.createdAt)}`,
      }),
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отозвать" }));
    expect(await within(dialog()).findByText("Запись не найдена.")).toBeTruthy();
  });
});
