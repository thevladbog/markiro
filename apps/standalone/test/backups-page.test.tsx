import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";

import { BACKUP_DIR_PROBLEMS, type BackupState } from "../src/host/backups.js";
import { HostError } from "../src/host/client.js";
import ru from "../src/i18n/ru.json";
import { formatSize, formatWhen } from "../src/office/backups/backup-format.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const MOSCOW = "Europe/Moscow";

/** An instant as the office writes it for the organization in Moscow. */
function at(instant: string): string {
  return formatWhen(instant, MOSCOW);
}

/** The second folder's last copy failed: the share is off. */
const SECOND_FAILED: BackupState = {
  ...HEALTHY_BACKUPS,
  second: {
    dir: "\\\\ADMIN-PC\\MarkiroCopies",
    lastAttempt: {
      at: "2026-10-09T14:00:04Z",
      trigger: "scheduled",
      ok: false,
      code: "destination_unavailable",
    },
    copies: [backupCopy("2026-10-09T10:00:00Z")],
  },
};

/** A restore of 15:00 that two stations wait for. */
const HELD: BackupState = {
  ...HEALTHY_BACKUPS,
  restoreHold: {
    since: "2026-10-09T15:00:00Z",
    epoch: "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e",
    stations: [
      {
        id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        name: "Станция линии 1",
        lastSeenAt: "2026-10-09T15:06:00Z",
        reconciled: true,
      },
      {
        id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
        name: "Станция линии 2",
        lastSeenAt: null,
        reconciled: false,
      },
    ],
  },
};

function conflict(details: Record<string, unknown>): HostError {
  return new HostError({ kind: "api", code: "conflict", message: "", status: 409, details });
}

function validation(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    message: "",
    status: 400,
    details: { field },
  });
}

/** A session of the administrator (or `user`) whose organization is in Moscow. */
function sessionOf(user?: typeof TECHNOLOGIST): FakeOfficeSession {
  const session = fakeOfficeSession(user === undefined ? {} : { user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  return session;
}

async function openBackups(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Резервные копии" }));
  await screen.findByRole("heading", { name: "Резервные копии", level: 1 });
  // The page waits for the organization's profile (its time zone) before it shows times.
  await screen.findByRole("heading", { name: "Папка на компьютере хоста", level: 2 });
}

function card(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title, level: 2 });
  const found = heading.closest(".mk-card");
  if (!(found instanceof HTMLElement)) throw new Error(`no card ${title}`);
  return found;
}

const RESUME = "Возобновить приём данных станций";

describe("Резервные копии", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows a technologist both folders, the failed copy and how to restore, with no controls but with the reason", async () => {
    const session = sessionOf(TECHNOLOGIST);
    session.api.getBackups.mockResolvedValue(SECOND_FAILED);
    await openBackups(session);
    expect(
      screen.getByText("Последняя копия во вторую папку не удалась: папка недоступна."),
    ).toBeTruthy();
    const local = card("Папка на компьютере хоста");
    expect(within(local).getByText("C:\\ProgramData\\Markiro\\Host\\backups")).toBeTruthy();
    expect(
      within(local).getByText(
        `${at("2026-10-09T14:00:00Z")}, ${formatSize(4 * 1024 * 1024, i18n.t)}`,
      ),
    ).toBeTruthy();
    expect(within(local).getByText(`${at("2026-10-09T14:00:03Z")}: успешно`)).toBeTruthy();
    expect(
      within(local).getByText("Сделать копию вручную может только администратор."),
    ).toBeTruthy();
    const second = card("Вторая папка");
    expect(within(second).getByText("\\\\ADMIN-PC\\MarkiroCopies")).toBeTruthy();
    expect(
      within(second).getByText(`${at("2026-10-09T14:00:04Z")}: не удалась — папка недоступна`),
    ).toBeTruthy();
    expect(
      within(second).getByText("Изменять эти данные может только администратор."),
    ).toBeTruthy();
    const rows = within(card("Копии на компьютере хоста")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("Вручную")).toBeTruthy();
    expect(within(card("Восстановление")).getByText(/sc stop MarkiroHost/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сделать копию сейчас" })).toBeNull();
    expect(screen.queryByLabelText("Путь ко второй папке")).toBeNull();
  });

  it("writes every time in the organization's zone and says so", async () => {
    const session = sessionOf();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" });
    session.api.getBackups.mockResolvedValue(SECOND_FAILED);
    await openBackups(session);
    expect(
      screen.getByText("Время указано в часовом поясе организации: Asia/Vladivostok."),
    ).toBeTruthy();
    const local = card("Папка на компьютере хоста");
    const vladivostok = (instant: string) => formatWhen(instant, "Asia/Vladivostok");
    expect(within(local).getByText(`${vladivostok("2026-10-09T14:00:03Z")}: успешно`)).toBeTruthy();
    expect(
      within(card("Копии на компьютере хоста")).getByText(vladivostok("2026-10-09T14:00:00Z")),
    ).toBeTruthy();
    expect(vladivostok("2026-10-09T14:00:00Z")).not.toBe(at("2026-10-09T14:00:00Z"));
  });

  it("falls back to this PC's clock, and says so, when the profile does not load", async () => {
    const failing = fakeOfficeSession();
    failing.api.getOrg.mockRejectedValue(new Error("down"));
    await openBackups(failing);
    expect(
      screen.getByText(
        "Профиль организации не загрузился: время указано по часам этого компьютера.",
      ),
    ).toBeTruthy();
    expect(
      within(card("Папка на компьютере хоста")).getByText(
        `${formatWhen("2026-10-09T14:00:03Z")}: успешно`,
      ),
    ).toBeTruthy();
  });

  it("says a zone this PC lacks is unknown to it", async () => {
    const session = sessionOf();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Mars/Olympus" });
    await openBackups(session);
    expect(
      screen.getByText(
        "Часовой пояс организации неизвестен этому компьютеру: время указано по его часам.",
      ),
    ).toBeTruthy();
  });

  it("shows no time until it knows the organization's zone", async () => {
    const session = fakeOfficeSession();
    let release: () => void = () => undefined;
    session.api.getOrg.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" });
      }),
    );
    session.api.getBackups.mockResolvedValue(SECOND_FAILED);
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Резервные копии" }));
    await screen.findByRole("heading", { name: "Резервные копии", level: 1 });
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Папка на компьютере хоста" })).toBeNull();
    expect(screen.queryByText(/успешно/)).toBeNull();
    release();
    const local = await screen.findByRole("heading", { name: "Папка на компьютере хоста" });
    expect(
      within(local.closest(".mk-card") as HTMLElement).getByText(
        `${formatWhen("2026-10-09T14:00:03Z", "Asia/Vladivostok")}: успешно`,
      ),
    ).toBeTruthy();
  });

  it("shows the warning of a held restore on «Обзор» only when it can write its time in the organization's zone", async () => {
    const session = fakeOfficeSession();
    let release: () => void = () => undefined;
    session.api.getOrg.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(ORG_PROFILE);
      }),
    );
    session.api.getBackups.mockResolvedValue(HELD);
    renderOffice(session);
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalled());
    await screen.findByText(/Вы вошли как/);
    expect(screen.queryByText(/Хост восстановлен из копии/)).toBeNull();
    release();
    expect(await screen.findByText(/Хост восстановлен из копии/)).toBeTruthy();
  });

  it("makes a copy now and follows it until it is made, then stops asking quickly", async () => {
    const session = sessionOf();
    const running: BackupState = {
      ...HEALTHY_BACKUPS,
      running: { trigger: "manual", startedAt: "2026-10-09T14:20:00Z" },
    };
    const made: BackupState = {
      ...HEALTHY_BACKUPS,
      now: "2026-10-09T14:20:05Z",
      local: {
        ...HEALTHY_BACKUPS.local,
        lastAttempt: { at: "2026-10-09T14:20:00Z", trigger: "manual", ok: true, code: null },
        copies: [backupCopy("2026-10-09T14:20:00Z", "manual"), ...HEALTHY_BACKUPS.local.copies],
      },
    };
    session.api.getBackups
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(running)
      .mockResolvedValue(made);
    session.api.startBackup.mockResolvedValue(running);
    await openBackups(session);
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию сейчас" }));
    expect(await screen.findByRole("button", { name: "Копия делается…" })).toBeTruthy();
    expect(session.api.startBackup).toHaveBeenCalledWith("office-session-token");
    expect(
      await screen.findByText("Копия сделана и проверена.", undefined, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сделать копию сейчас" })).toBeTruthy();
    expect(within(card("Копии на компьютере хоста")).getAllByRole("row")).toHaveLength(4);
    // A finished copy ends the quick reading: the next read is a minute away.
    const reads = session.api.getBackups.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(session.api.getBackups.mock.calls.length).toBe(reads);
  }, 10_000);

  it("does not call an hour-old success the copy it just asked for", async () => {
    const session = sessionOf();
    // The host's 202 shows nothing running and the last attempt an hour old.
    const idle: BackupState = { ...HEALTHY_BACKUPS, now: "2026-10-09T15:20:00Z" };
    session.api.getBackups.mockResolvedValue(idle);
    session.api.startBackup.mockResolvedValue(idle);
    await openBackups(session);
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию сейчас" }));
    await waitFor(() => expect(session.api.startBackup).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Сделать копию сейчас" });
    expect(screen.queryByText("Копия сделана и проверена.")).toBeNull();
  });

  it("shows the running copy, not an error, when a copy runs already", async () => {
    const session = sessionOf();
    const running: BackupState = {
      ...HEALTHY_BACKUPS,
      running: { trigger: "scheduled", startedAt: "2026-10-09T14:19:00Z" },
    };
    session.api.getBackups
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValueOnce(HEALTHY_BACKUPS)
      .mockResolvedValue(running);
    session.api.startBackup.mockRejectedValue(conflict({ constraint: "backup_running" }));
    await openBackups(session);
    const reads = session.api.getBackups.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию сейчас" }));
    expect(await screen.findByText("Копия уже делается — дождитесь её.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Копия делается…" })).toBeTruthy();
    expect(session.api.getBackups.mock.calls.length).toBe(reads + 1);
    expect(document.querySelector(".mk-alert--error")).toBeNull();
    expect(screen.queryByText(ru.errors.api.conflict)).toBeNull();
  });

  it("explains any other refusal of «Сделать копию сейчас» and lets the administrator try again", async () => {
    const session = sessionOf();
    session.api.startBackup.mockRejectedValue(
      new HostError({ kind: "api", code: "internal", message: "", status: 500 }),
    );
    await openBackups(session);
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию сейчас" }));
    expect(await screen.findByText("На хосте произошла ошибка. Повторите попытку.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Сделать копию сейчас" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("saves the second folder, and shows why the host refused one", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, second: null });
    session.api.updateBackupSettings
      .mockRejectedValueOnce(conflict({ constraint: "backup_dir", reason: "missing" }))
      .mockRejectedValueOnce(validation("secondDir"))
      .mockResolvedValueOnce({
        ...HEALTHY_BACKUPS,
        second: { dir: "E:\\Markiro", lastAttempt: null, copies: [] },
        settingsRev: 8,
      });
    await openBackups(session);
    expect(screen.getByText("Вторая папка не задана.")).toBeTruthy();
    const input = screen.getByLabelText("Путь ко второй папке");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите полный путь к папке, до 260 символов")).toBeTruthy();
    expect(session.api.updateBackupSettings).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: " E:\\Markiro " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Папка не найдена. Проверьте путь и что компьютер или флешка подключены.",
      ),
    ).toBeTruthy();
    expect(session.api.updateBackupSettings).toHaveBeenLastCalledWith("office-session-token", {
      secondDir: "E:\\Markiro",
      expectedRev: 7,
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Хост не принял этот путь: укажите полный путь к папке, например E:\\Markiro или \\\\ПК\\Папка.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(within(card("Вторая папка")).getByText("E:\\Markiro")).toBeTruthy();
    expect(screen.getByText("Ещё не было")).toBeTruthy();
  });

  it.each(BACKUP_DIR_PROBLEMS)(
    "says in plain words why the host cannot use a folder: %s",
    async (reason) => {
      const session = sessionOf();
      session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, second: null });
      session.api.updateBackupSettings.mockRejectedValue(
        conflict({ constraint: "backup_dir", reason }),
      );
      await openBackups(session);
      fireEvent.change(screen.getByLabelText("Путь ко второй папке"), {
        target: { value: "E:\\Markiro" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      expect(await screen.findByText(ru.office.backups.dirProblems[reason])).toBeTruthy();
      expect(screen.queryByText(ru.office.backups.dirProblems.unknown)).toBeNull();
    },
  );

  it("says a reason a newer host adds as a folder that cannot take copies", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, second: null });
    session.api.updateBackupSettings.mockRejectedValue(
      conflict({ constraint: "backup_dir", reason: "on_fire" }),
    );
    await openBackups(session);
    fireEvent.change(screen.getByLabelText("Путь ко второй папке"), {
      target: { value: "E:\\Markiro" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Хост не может делать копии в эту папку.")).toBeTruthy();
  });

  it.each([
    [
      "\\\\?\\UNC\\ADMIN-PC\\MarkiroCopies",
      "Пути вида \\\\?\\ и \\\\.\\ не принимаются, в том числе \\\\?\\UNC\\…. Для общей папки укажите \\\\ПК\\Папка, для флешки — E:\\Markiro.",
    ],
    ["E:\\a\\..\\b", "В пути не должно быть частей «..»: укажите папку полным путём."],
    ["Markiro", "Укажите полный путь: диск и папка (E:\\Markiro) или общая папка (\\\\ПК\\Папка)."],
    ["E:\\Mark\tiro", "Уберите табуляцию, перенос строки или другой служебный символ"],
    ["E:\\" + "а".repeat(260), "Укажите полный путь к папке, до 260 символов"],
  ])("refuses the folder %j in plain words before the host sees it", async (path, message) => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue({ ...HEALTHY_BACKUPS, second: null });
    await openBackups(session);
    fireEvent.change(screen.getByLabelText("Путь ко второй папке"), { target: { value: path } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(session.api.updateBackupSettings).not.toHaveBeenCalled();
    // The field says what is wrong with it, to a screen reader as well.
    const field = screen.getByLabelText("Путь ко второй папке");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("stops copying into the second folder", async () => {
    const session = sessionOf();
    session.api.updateBackupSettings.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      second: null,
      settingsRev: 8,
    });
    await openBackups(session);
    fireEvent.click(screen.getByRole("button", { name: "Не копировать во вторую папку" }));
    expect(await screen.findByText("Вторая папка не задана.")).toBeTruthy();
    expect(session.api.updateBackupSettings).toHaveBeenCalledWith("office-session-token", {
      secondDir: null,
      expectedRev: 7,
    });
    expect(
      screen.getByText(
        "Вторая папка не задана: если сломается компьютер хоста, копий не останется.",
      ),
    ).toBeTruthy();
  });

  it("shows the stations a restore waits for, and which of them gave their blocks back", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HELD);
    await openBackups(session);
    expect(
      screen.getByText(
        `Хост восстановлен из копии ${at("2026-10-09T15:00:00Z")} и не принимает данные станций. Станций в списке: 2. Возобновляйте приём только после проверок SSCC.`,
      ),
    ).toBeTruthy();
    const hold = card("Приём данных станций остановлен");
    expect(within(hold).getByText(at("2026-10-09T15:00:00Z"))).toBeTruthy();
    expect(within(hold).getByText("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")).toBeTruthy();
    const rows = within(hold).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Станция линии 1")).toBeTruthy();
    expect(within(rows[0]!).getByText(at("2026-10-09T15:06:00Z"))).toBeTruthy();
    expect(within(rows[1]!).getByText("—")).toBeTruthy();
    // Plan РК-С: a station gives its blocks back by itself once it is online.
    // The state is words in the cell, not a colour.
    expect(within(rows[0]!).getByText("Вернула")).toBeTruthy();
    expect(within(rows[0]!).queryByText("Не вернула")).toBeNull();
    expect(within(rows[1]!).getByText("Не вернула")).toBeTruthy();
    expect(within(rows[1]!).queryByText("Вернула")).toBeNull();
    expect(within(hold).getByRole("columnheader", { name: "Блоки SSCC" })).toBeTruthy();
    expect(
      within(hold).getByText(
        "Станция возвращает хосту свои блоки SSCC сама, как только выйдет на связь. Отметка «Вернула» ставится, когда хост принял первую часть её блоков. Станция, которая ещё не получала блоков SSCC, остаётся «Не вернула»: возвращать ей нечего. Станция на выключенном или неисправном компьютере блоков не вернёт, поэтому приём возобновляется только по решению администратора после проверок SSCC.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/пока не возвращают/)).toBeNull();
  });

  it("makes an administrator confirm the resume in words that tell the truth, and then resumes", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HELD);
    session.api.resumeFacts.mockResolvedValue(HEALTHY_BACKUPS);
    await openBackups(session);
    const hold = card("Приём данных станций остановлен");
    fireEvent.click(within(hold).getByRole("button", { name: RESUME }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Не возобновляйте приём до проверок SSCC/)).toBeTruthy();
    expect(within(dialog).getByText("Вернули свои блоки SSCC: 1 из 2 станций.")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "«Не вернула» не всегда сбой: станция, которая ещё не получала блоков SSCC, их и не возвращает. По остальным станциям, не вернувшим блоки, сверьте счётчики по памятке.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        `Приём остановлен с ${at("2026-10-09T15:00:00Z")}, эпоха восстановления 5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e.`,
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: RESUME }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(session.api.resumeFacts).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Проверки SSCC выполнены. Я возобновляю приём, зная, какие станции не вернули свои блоки.",
      }),
    );
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Приём данных станций остановлен" })).toBeNull(),
    );
    expect(session.api.resumeFacts).toHaveBeenCalledWith("office-session-token");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByText("Приём данных станций возобновлён.")).toBeTruthy();
  });

  it.each([
    { reconciled: [true], text: "Вернули свои блоки SSCC: 1 из 1 станции." },
    { reconciled: [false], text: "Вернули свои блоки SSCC: 0 из 1 станции." },
    { reconciled: [true, true, false], text: "Вернули свои блоки SSCC: 2 из 3 станций." },
    {
      reconciled: [false, true, true, true, true],
      text: "Вернули свои блоки SSCC: 4 из 5 станций.",
    },
    {
      reconciled: Array.from({ length: 21 }, (_, index) => index === 0),
      text: "Вернули свои блоки SSCC: 1 из 21 станции.",
    },
    {
      reconciled: Array.from({ length: 11 }, () => false),
      text: "Вернули свои блоки SSCC: 0 из 11 станций.",
    },
  ])("counts the stations that gave their blocks back: $text", async ({ reconciled, text }) => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      restoreHold: {
        ...HELD.restoreHold!,
        stations: reconciled.map((done, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          name: `Станция ${index + 1}`,
          lastSeenAt: null,
          reconciled: done,
        })),
      },
    });
    await openBackups(session);
    fireEvent.click(
      within(card("Приём данных станций остановлен")).getByRole("button", { name: RESUME }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(text)).toBeTruthy();
  });

  it("marks every station by its own reconciled flag, whatever their order", async () => {
    const session = sessionOf();
    const [first, second] = HELD.restoreHold!.stations;
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      restoreHold: {
        ...HELD.restoreHold!,
        stations: [
          { ...second!, name: "Б", reconciled: false },
          { ...first!, name: "А", reconciled: true },
          { ...second!, id: "2f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", name: "В", reconciled: true },
        ],
      },
    });
    await openBackups(session);
    const rows = within(card("Приём данных станций остановлен")).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Не вернула")).toBeTruthy();
    expect(within(rows[1]!).getByText("Вернула")).toBeTruthy();
    expect(within(rows[2]!).getByText("Вернула")).toBeTruthy();
  });

  it("tells in the restore steps that a station gives its blocks back by itself", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HEALTHY_BACKUPS);
    await openBackups(session);
    expect(
      screen.getByText(
        "Текущая база сохраняется рядом. Хост поднимает счётчики SSCC и номера смен с запасом. Станции, выйдя на связь, сами возвращают ему свои блоки SSCC; приём их данных администратор возобновляет здесь, после проверок SSCC.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Станции пока не возвращают/)).toBeNull();
  });

  it("asks again for the confirmation every time the dialog opens", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HELD);
    await openBackups(session);
    const open = () =>
      fireEvent.click(
        within(card("Приём данных станций остановлен")).getByRole("button", { name: RESUME }),
      );
    open();
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    open();
    const dialog = await screen.findByRole("alertdialog");
    expect(
      (within(dialog).getByRole("button", { name: RESUME }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the dialog open and shows why the host refused the resume", async () => {
    const session = sessionOf();
    session.api.getBackups.mockResolvedValue(HELD);
    session.api.resumeFacts.mockRejectedValue(
      new HostError({ kind: "api", code: "forbidden", message: "", status: 403 }),
    );
    await openBackups(session);
    fireEvent.click(
      within(card("Приём данных станций остановлен")).getByRole("button", { name: RESUME }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: RESUME }));
    expect(await within(dialog).findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Приём данных станций остановлен" })).toBeTruthy();
  });

  it("shows a technologist the hold with no way to resume, and says why", async () => {
    const session = sessionOf(TECHNOLOGIST);
    session.api.getBackups.mockResolvedValue({
      ...HEALTHY_BACKUPS,
      restoreHold: { ...HELD.restoreHold!, stations: [] },
    });
    await openBackups(session);
    const hold = card("Приём данных станций остановлен");
    expect(within(hold).getByText("Подключённых станций нет")).toBeTruthy();
    expect(within(hold).getByText("Возобновить приём может только администратор.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: RESUME })).toBeNull();
  });

  it("keeps the page and says the state did not refresh when a later read fails, then recovers", async () => {
    const session = sessionOf();
    const running: BackupState = {
      ...HEALTHY_BACKUPS,
      running: { trigger: "manual", startedAt: "2026-10-09T14:20:00Z" },
    };
    session.api.getBackups
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(HEALTHY_BACKUPS);
    await openBackups(session);
    expect(
      await screen.findByText(
        "Состояние не обновилось: хост не ответил. Показаны последние полученные данные.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Папка на компьютере хоста", level: 2 }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.queryByText(/Состояние не обновилось/)).toBeNull());
    expect(screen.getByRole("button", { name: "Сделать копию сейчас" })).toBeTruthy();
  }, 10_000);

  it("announces the warnings in one polite region that is on the page before them, with a tone a screen reader hears", async () => {
    const session = sessionOf();
    let release: (state: BackupState) => void = () => undefined;
    const pending = new Promise<BackupState>((resolve) => {
      release = resolve;
    });
    session.api.getBackups.mockReturnValue(pending);
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Резервные копии" }));
    await screen.findByRole("heading", { name: "Резервные копии", level: 1 });
    const region = document.querySelector('main [aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region?.textContent).toBe("");
    release({ ...SECOND_FAILED, local: { ...SECOND_FAILED.local, copies: [] } });
    const text = await screen.findByText(
      "Последняя копия во вторую папку не удалась: папка недоступна.",
    );
    expect(region?.contains(text)).toBe(true);
    const alert = text.closest(".mk-alert");
    expect(alert?.getAttribute("role")).toBe("presentation");
    expect(within(alert as HTMLElement).getByText("Ошибка:")).toBeTruthy();
    const quieter = screen.getByText("Проверенных копий ещё нет.").closest(".mk-alert");
    expect(region?.contains(quieter)).toBe(true);
    expect(within(quieter as HTMLElement).getByText("Внимание:")).toBeTruthy();
  });

  it("warns on «Обзор» and leads to the page", async () => {
    const session = sessionOf(TECHNOLOGIST);
    session.api.getBackups.mockResolvedValue(SECOND_FAILED);
    renderOffice(session);
    expect(
      await screen.findByText("Последняя копия во вторую папку не удалась: папка недоступна."),
    ).toBeTruthy();
    expect(session.api.getOrg).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Открыть «Резервные копии»" }));
    expect(await screen.findByRole("heading", { name: "Резервные копии", level: 1 })).toBeTruthy();
  });

  it("writes the time of a held restore on «Обзор» in the organization's zone", async () => {
    const session = sessionOf();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Vladivostok" });
    session.api.getBackups.mockResolvedValue(HELD);
    renderOffice(session);
    expect(
      await screen.findByText(
        `Хост восстановлен из копии ${formatWhen("2026-10-09T15:00:00Z", "Asia/Vladivostok")} и не принимает данные станций. Станций в списке: 2. Возобновляйте приём только после проверок SSCC.`,
      ),
    ).toBeTruthy();
  });

  it("says nothing on «Обзор» while the copies are well", async () => {
    const session = sessionOf();
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getBackups).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Открыть «Резервные копии»" })).toBeNull();
    expect(document.querySelector(".mk-alert")).toBeNull();
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("says nothing on «Обзор» when the host does not answer", async () => {
    const session = sessionOf();
    session.api.getBackups.mockRejectedValue(new Error("down"));
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getBackups).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Открыть «Резервные копии»" })).toBeNull();
    expect(document.querySelector(".mk-alert")).toBeNull();
  });
});
