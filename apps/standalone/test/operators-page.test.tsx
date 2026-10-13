import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { verifyPhc } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import type { OfficeOperator, OperatorCreate } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import { similarLogin } from "../src/office/operators/operator-forms.js";
import {
  fakeOfficeSession,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { findRowAction, hasRowAction, pressRowAction } from "./support/row-menu.js";

/** `office-operator.json`, with a role: one badge revoked, one in use. */
const ANNA: OfficeOperator = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
  active: true,
  hasPin: true,
  badges: [
    {
      id: "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19",
      label: null,
      createdAt: "2026-09-20T08:00:00Z",
      revokedAt: "2026-09-27T08:00:00Z",
    },
    {
      id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      label: "Пропуск №7",
      createdAt: "2026-09-27T08:00:00Z",
      revokedAt: null,
    },
  ],
  rev: 55,
};
const BORIS: OfficeOperator = {
  id: "5b9d2e4f-6a1c-4d3e-8f2a-7b6c5d4e3f21",
  login: "100",
  name: "Борис Орлов",
  role: null,
  active: true,
  hasPin: true,
  badges: [],
  rev: 40,
};
const VERA: OfficeOperator = {
  id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  login: "99",
  name: "Вера Лебедева",
  role: "Наладчик",
  active: true,
  hasPin: true,
  badges: [
    {
      id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
      label: null,
      createdAt: "2026-09-21T08:00:00Z",
      revokedAt: null,
    },
    {
      id: "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f",
      label: "Смена Б",
      createdAt: "2026-09-22T08:00:00Z",
      revokedAt: null,
    },
  ],
  rev: 41,
};
const GLEB: OfficeOperator = {
  id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  login: "042",
  name: "Глеб Сидоров",
  role: null,
  active: false,
  hasPin: true,
  badges: [],
  rev: 30,
};

/** What the host answers a create with: the operator it stored. */
function created(body: OperatorCreate): OfficeOperator {
  return {
    id: "9b2e4a6c-1d3f-4e5a-8b7c-6d5e4f3a2b1c",
    login: body.login,
    name: body.name,
    role: body.role,
    active: true,
    hasPin: true,
    badges: [],
    rev: 60,
  };
}

function refusal(code: string, details: Record<string, unknown>): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

/** The host refusing one field of a form: 422 with the field's name in `details`. */
function validationFailed(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 422,
    message: "the value is not valid",
    details: { field },
  });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  // The host's own order: by personnel number as text, inactive ones included.
  session.api.listOperators.mockResolvedValue([ANNA, GLEB, BORIS, VERA]);
  return session;
}

async function openOperators(session: FakeOfficeSession) {
  const view = renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Операторы" }));
  await screen.findByText("Анна Кузнецова");
  return view;
}

/** The personnel numbers, top to bottom. */
function logins(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/**
 * Clicks the dialog's submit button again once the earlier submit has
 * settled: a refused form enables the button in a render of its own, and a
 * click on the disabled button would do nothing.
 */
async function submitAgain(name: string): Promise<void> {
  const submit = within(dialog()).getByRole("button", { name });
  await waitFor(() => expect(submit).toHaveProperty("disabled", false));
  fireEvent.click(submit);
}

function fillNewOperator(): void {
  type("Табельный номер", " 0043 ");
  type("Имя", " Иван Петров ");
  type("Должность", " Наладчик ");
  // A PIN pasted with spaces around it: the form trims it, and the hash is of the trimmed PIN.
  type("PIN", " 4821 ");
  type("Повторите PIN", " 4821 ");
}

describe("office operators", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("keeps a row one button tall: «Изменить» and the «⋯» menu with the rest, the turn-off set apart, the column pinned to the card's right edge", async () => {
    await openOperators(adminSession());
    const anna = rowOf("Анна Кузнецова");
    const buttons = within(anna).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Изменить оператора «Анна Кузнецова»",
      "Действия: Анна Кузнецова",
    ]);
    fireEvent.click(buttons[1] as HTMLElement);
    const items = within(
      screen.getByRole("menu", { name: "Действия: Анна Кузнецова" }),
    ).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Сменить PIN оператора «Анна Кузнецова»",
      "Бейджи оператора «Анна Кузнецова»",
      "Сотрудник оператора «Анна Кузнецова»",
      "Выключить оператора «Анна Кузнецова»",
    ]);
    expect(items.map((item) => item.getAttribute("data-destructive"))).toEqual([
      null,
      null,
      null,
      "true",
    ]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // Turning an operator back on is no loss: not marked.
    expect(
      findRowAction(
        within(rowOf("Глеб Сидоров")),
        "Включить оператора «Глеб Сидоров»",
      ).getAttribute("data-destructive"),
    ).toBeNull();
    // The actions column stays in reach when the table is wider than its card.
    const heading = screen.getByRole("columnheader", { name: "Действия" });
    expect(heading.style.position).toBe("sticky");
    expect(heading.style.right).toBe("0px");
  });

  it("sits between «Линии» and «Устройства» in an administrator's menu", async () => {
    renderOffice(adminSession());
    await screen.findByRole("link", { name: "Операторы" });
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.slice(links.indexOf("Линии"), links.indexOf("Устройства") + 1)).toEqual([
      "Линии",
      "Смены",
      // «Сотрудники» (owner feedback on the first beta) sits right before «Операторы».
      "Сотрудники",
      "Операторы",
      "Устройства",
    ]);
  });

  it("is not in a technologist's menu", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Линии" });
    expect(screen.queryByRole("link", { name: "Операторы" })).toBeNull();
  });

  it("closes the page when the user's role changes to technologist", async () => {
    const session = adminSession();
    const view = await openOperators(session);
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office
          session={{ ...session, user: { ...session.user, role: "technologist" } }}
          labels={quietLabelRendering()}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByText("Анна Кузнецова")).toBeNull();
  });

  it("lists active operators first, each group by personnel number as text", async () => {
    await openOperators(adminSession());
    expect(logins()).toEqual(["0042", "100", "99", "042"]);
    const anna = rowOf("Анна Кузнецова");
    expect(within(anna).getByText("Упаковщик")).toBeTruthy();
    expect(within(anna).getByText("PIN задан")).toBeTruthy();
    // The revoked badge is not counted.
    expect(within(anna).getByText("1 — Пропуск №7")).toBeTruthy();
    expect(within(anna).getByText("Может входить")).toBeTruthy();
    expect(within(rowOf("Борис Орлов")).getByText("Нет")).toBeTruthy();
    expect(within(rowOf("Борис Орлов")).getByText("—")).toBeTruthy();
    expect(within(rowOf("Вера Лебедева")).getByText("2 — Без подписи, Смена Б")).toBeTruthy();
    const gleb = rowOf("Глеб Сидоров");
    expect(within(gleb).getByText("Выключен")).toBeTruthy();
    expect(hasRowAction(within(gleb), "Включить оператора «Глеб Сидоров»")).toBe(true);
    expect(hasRowAction(within(anna), "Выключить оператора «Анна Кузнецова»")).toBe(true);
  });

  it("adds an operator with the trimmed values and only a hash of the PIN", async () => {
    const session = adminSession();
    session.api.createOperator.mockImplementation(async (_token, body) => created(body));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(session.api.createOperator).toHaveBeenCalledTimes(1));
    expect(session.api.createOperator.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          login: "0043",
          name: "Иван Петров",
          role: "Наладчик",
          pinPhc: expect.stringMatching(/^pbkdf2\$sha256\$100000\$/),
        },
      ],
    ]);
    const pinPhc = session.api.createOperator.mock.calls[0]?.[1].pinPhc ?? "";
    await expect(verifyPhc("4821", pinPhc)).resolves.toBe(true);
    expect(await screen.findByText("Оператор «Иван Петров» добавлен.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(logins()).toEqual(["0042", "0043", "100", "99", "042"]);
  });

  it("sends a blank role as none", async () => {
    const session = adminSession();
    session.api.createOperator.mockImplementation(async (_token, body) => created(body));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    type("Должность", "   ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await screen.findByText("Оператор «Иван Петров» добавлен.");
    expect(session.api.createOperator.mock.calls[0]?.[1].role).toBeNull();
  });

  it("checks the personnel number, the PIN and its repeat before sending", async () => {
    const session = adminSession();
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    type("Табельный номер", "42");
    type("Имя", "Иван Петров");
    type("PIN", "123");
    type("Повторите PIN", "123");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Табельный номер — от 3 до 12 цифр")).toBeTruthy();
    expect(screen.getByText("PIN — от 4 до 6 цифр")).toBeTruthy();
    type("Табельный номер", "042");
    type("PIN", "4821");
    type("Повторите PIN", "4812");
    await submitAgain("Добавить");
    expect(await screen.findByText("PIN-коды не совпадают")).toBeTruthy();
    expect(session.api.createOperator).not.toHaveBeenCalled();
  });

  it("says under the personnel number when it is taken", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(refusal("conflict", { constraint: "login" }));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Этот табельный номер уже занят");
    expect(screen.getByLabelText("Табельный номер").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("names the number in the way when the host refuses one that differs from it only by leading zeros", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(
      refusal("conflict", { constraint: "login", similarLogin: "0042" }),
    );
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    type("Табельный номер", " 042 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText(
      "Похож на занятый табельный номер 0042: номера, которые отличаются только нулями в начале, легко перепутать",
    );
    expect(screen.getByLabelText("Табельный номер").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says a number is taken when the number the host names is the one typed", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(
      refusal("conflict", { constraint: "login", similarLogin: "0043" }),
    );
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Этот табельный номер уже занят")).toBeTruthy();
  });

  it("puts the cursor on the personnel number whichever way the host refused it", async () => {
    const session = adminSession();
    session.api.createOperator
      .mockRejectedValueOnce(refusal("conflict", { constraint: "login", similarLogin: "0042" }))
      .mockRejectedValueOnce(refusal("conflict", { constraint: "login" }));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    type("Табельный номер", "042");
    const login = screen.getByLabelText("Табельный номер");
    const name = screen.getByLabelText("Имя");
    act(() => name.focus());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await screen.findByText(/^Похож на занятый табельный номер 0042/);
    expect(document.activeElement).toBe(login);
    act(() => name.focus());
    await submitAgain("Добавить");
    await screen.findByText("Этот табельный номер уже занят");
    expect(document.activeElement).toBe(login);
  });

  it("names the number the host names after a number it called taken, and takes the name away when it is the one typed", async () => {
    const session = adminSession();
    session.api.createOperator
      .mockRejectedValueOnce(refusal("conflict", { constraint: "login", similarLogin: "0042" }))
      .mockRejectedValueOnce(refusal("conflict", { constraint: "login", similarLogin: "00042" }))
      .mockRejectedValueOnce(refusal("conflict", { constraint: "login", similarLogin: "042" }));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    type("Табельный номер", "42000");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await screen.findByText(/^Похож на занятый табельный номер 0042:/);
    await submitAgain("Добавить");
    await screen.findByText(/^Похож на занятый табельный номер 00042:/);
    expect(screen.queryByText(/номер 0042:/)).toBeNull();
    type("Табельный номер", "042");
    await submitAgain("Добавить");
    expect(await screen.findByText("Этот табельный номер уже занят")).toBeTruthy();
    expect(screen.queryByText(/^Похож на занятый/)).toBeNull();
    expect(session.api.createOperator).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "another constraint",
      refusal("conflict", { constraint: "badge", similarLogin: "0042" }),
      "Такая запись уже есть.",
    ],
    ["another code", validationFailed("login"), "Хост не принял это значение. Проверьте его."],
    [
      "a number that is no text",
      refusal("conflict", { constraint: "login", similarLogin: 42 }),
      "Этот табельный номер уже занят",
    ],
    [
      "no number",
      refusal("conflict", { constraint: "login", similarLogin: null }),
      "Этот табельный номер уже занят",
    ],
  ])("does not call a number similar on %s", async (_name, error, shown) => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(error);
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText(shown)).toBeTruthy();
    expect(screen.queryByText(/^Похож на занятый/)).toBeNull();
  });

  it("says under the PIN when the host refuses its hash in a new operator", async () => {
    const session = adminSession();
    session.api.createOperator.mockRejectedValueOnce(validationFailed("pinPhc"));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.getByLabelText("PIN").getAttribute("aria-describedby")).toBe(message.id);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("hashes and sends one operator for a double click", async () => {
    const session = adminSession();
    session.api.createOperator.mockImplementation(async (_token, body) => created(body));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить оператора" }));
    fillNewOperator();
    const add = within(dialog()).getByRole("button", { name: "Добавить" });
    // One `act` renders nothing between the clicks: only the dialog's own
    // flag, set at the first submit, can turn the second one away.
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await screen.findByText("Оператор «Иван Петров» добавлен.");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.api.createOperator).toHaveBeenCalledTimes(1);
  });

  it("changes the name and clears the role with the loaded revision, in place", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({
      ...VERA,
      name: "Вера Орлова",
      role: null,
      rev: 62,
    });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить оператора «Вера Лебедева»" }));
    expect(within(dialog()).getByText("Табельный номер 99. Его нельзя изменить.")).toBeTruthy();
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Имя", " Вера Орлова ");
    type("Должность", "");
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", VERA.id, { name: "Вера Орлова", role: null, expectedRev: 41 }],
    ]);
    expect(logins()).toEqual(["0042", "100", "99", "042"]);
    expect(within(rowOf("Вера Орлова")).getByText("—")).toBeTruthy();
  });

  it("sends no role when only the name changed", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...ANNA, name: "Анна Петрова", rev: 63 });
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить оператора «Анна Кузнецова»" }));
    type("Имя", "Анна Петрова");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { name: "Анна Петрова", expectedRev: 55 }],
    ]);
  });

  it("offers to load the operators again after a stale change", async () => {
    const session = adminSession();
    session.api.updateOperator.mockRejectedValueOnce(refusal("stale_revision", { currentRev: 70 }));
    await openOperators(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить оператора «Анна Кузнецова»" }));
    type("Имя", "Анна Петрова");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listOperators).toHaveBeenCalledTimes(2));
  });

  it("offers to load the operators again after a stale PIN change", async () => {
    const session = adminSession();
    session.api.updateOperator.mockRejectedValueOnce(refusal("stale_revision", { currentRev: 70 }));
    await openOperators(session);
    pressRowAction(screen, "Сменить PIN оператора «Анна Кузнецова»");
    type("PIN", "1357");
    type("Повторите PIN", "1357");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сменить PIN" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listOperators).toHaveBeenCalledTimes(2));
  });

  it("says under the PIN when the host refuses its hash in a new PIN", async () => {
    const session = adminSession();
    session.api.updateOperator.mockRejectedValueOnce(validationFailed("pinPhc"));
    await openOperators(session);
    pressRowAction(screen, "Сменить PIN оператора «Анна Кузнецова»");
    type("PIN", "1357");
    type("Повторите PIN", "1357");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сменить PIN" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.getByLabelText("PIN").getAttribute("aria-describedby")).toBe(message.id);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("replaces the PIN with a new hash and the loaded revision", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...ANNA, rev: 64 });
    await openOperators(session);
    pressRowAction(screen, "Сменить PIN оператора «Анна Кузнецова»");
    expect(
      within(dialog()).getByText(
        "Прежний PIN перестанет работать на станциях, как только они получат изменение.",
      ),
    ).toBeTruthy();
    // Spaces around both, as a pasted PIN has them: the hash is of the trimmed PIN.
    type("PIN", " 1357 ");
    type("Повторите PIN", " 1375 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сменить PIN" }));
    expect(await screen.findByText("PIN-коды не совпадают")).toBeTruthy();
    type("Повторите PIN", " 1357 ");
    await submitAgain("Сменить PIN");
    expect(await screen.findByText("PIN оператора «Анна Кузнецова» изменён.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      [
        "office-session-token",
        ANNA.id,
        { pinPhc: expect.stringMatching(/^pbkdf2\$sha256\$100000\$/), expectedRev: 55 },
      ],
    ]);
    const pinPhc = session.api.updateOperator.mock.calls[0]?.[2].pinPhc ?? "";
    await expect(verifyPhc("1357", pinPhc)).resolves.toBe(true);
  });

  it("offers to load the operators again after a stale turn-off", async () => {
    const session = adminSession();
    session.api.updateOperator.mockRejectedValueOnce(refusal("stale_revision", { currentRev: 70 }));
    await openOperators(session);
    pressRowAction(screen, "Выключить оператора «Анна Кузнецова»");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Выключить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listOperators).toHaveBeenCalledTimes(2));
  });

  it("turns an operator off after saying they can no longer sign in on the stations", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...ANNA, active: false, rev: 65 });
    await openOperators(session);
    pressRowAction(screen, "Выключить оператора «Анна Кузнецова»");
    expect(
      within(dialog()).getByText(
        "Оператор «Анна Кузнецова» больше не сможет входить на станциях, как только они получат изменение. Включить его снова можно здесь же.",
      ),
    ).toBeTruthy();
    const turnOff = within(dialog()).getByRole("button", { name: "Выключить" });
    // Taking an operator out of use is the destructive kind of submit.
    expect(turnOff.className).toContain("mk-btn--destructive");
    fireEvent.click(turnOff);
    expect(await screen.findByText("Оператор «Анна Кузнецова» выключен.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", ANNA.id, { active: false, expectedRev: 55 }],
    ]);
    expect(logins()).toEqual(["100", "99", "0042", "042"]);
    expect(within(rowOf("Анна Кузнецова")).getByText("Выключен")).toBeTruthy();
  });

  it("turns an operator back on after a light confirmation", async () => {
    const session = adminSession();
    session.api.updateOperator.mockResolvedValue({ ...GLEB, active: true, rev: 66 });
    await openOperators(session);
    pressRowAction(screen, "Включить оператора «Глеб Сидоров»");
    expect(
      within(dialog()).getByText(
        "Оператор «Глеб Сидоров» снова сможет входить на станциях по своему PIN и бейджам, как только они получат изменение.",
      ),
    ).toBeTruthy();
    const turnOn = within(dialog()).getByRole("button", { name: "Включить" });
    // Giving access back is a light confirmation: the primary submit.
    expect(turnOn.className).toContain("mk-btn--primary");
    expect(turnOn.className).not.toContain("mk-btn--destructive");
    fireEvent.click(turnOn);
    expect(await screen.findByText("Оператор «Глеб Сидоров» включён.")).toBeTruthy();
    expect(session.api.updateOperator.mock.calls).toStrictEqual([
      ["office-session-token", GLEB.id, { active: true, expectedRev: 30 }],
    ]);
    expect(logins()).toEqual(["0042", "042", "100", "99"]);
  });
});

describe("similarLogin", () => {
  const taken = (details: Record<string, unknown>) => refusal("conflict", details);

  it("is the number the host names when it differs from the one typed", () => {
    expect(similarLogin(taken({ constraint: "login", similarLogin: "0042" }), "042")).toBe("0042");
  });

  it("is nothing for the number typed, however it was padded when typed", () => {
    expect(similarLogin(taken({ constraint: "login", similarLogin: "0043" }), "0043")).toBeNull();
    expect(similarLogin(taken({ constraint: "login", similarLogin: "0043" }), " 0043 ")).toBeNull();
  });

  it("is nothing for a refusal that is not a conflict on the number or names no text", () => {
    expect(similarLogin(taken({ constraint: "login" }), "042")).toBeNull();
    expect(similarLogin(taken({ constraint: "login", similarLogin: 42 }), "042")).toBeNull();
    expect(similarLogin(taken({ constraint: "badge", similarLogin: "0042" }), "042")).toBeNull();
    expect(similarLogin(validationFailed("login"), "042")).toBeNull();
    const notAConflict = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 422,
      message: "the value is not valid",
      details: { constraint: "login", similarLogin: "0042" },
    });
    expect(similarLogin(notAConflict, "042")).toBeNull();
    expect(similarLogin(new Error("0042"), "042")).toBeNull();
    expect(similarLogin(undefined, "042")).toBeNull();
  });
});
