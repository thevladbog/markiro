import i18n from "i18next";
import { describe, expect, it } from "vitest";

import type { AboutData } from "../src/office/info/about-data.js";
import { PROGRAM_ROWS } from "../src/office/info/ProgramSection.js";
import { collectSupportBlocks, SUPPORT_CONTRIBUTORS } from "../src/office/info/support-blocks.js";
import {
  buildSupportReport,
  plainAddress,
  safeValue,
  shortId,
  type SupportFacts,
} from "../src/office/info/support-report.js";

const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const FACTS: SupportFacts = {
  generatedAt: new Date("2026-10-13T09:41:05Z"),
  appVersion: "0.1.0",
  buildCommit: "a4eef5cd6",
  buildDate: "2026-10-13",
  appProtocol: 3,
  hostVersion: "0.1.0",
  hostProtocol: 3,
  hostMinProtocol: 3,
  role: "host",
  os: "Windows 11",
  arch: "x64",
  webview: "WebView2 130.0.2849.80",
  hostReachable: true,
  linkState: "online",
  hostAddress: "https://127.0.0.1:45710",
  hostId: HOST_ID,
  lastBackupAt: "2026-10-13T08:00:00Z",
};

/** Secrets as the app holds them, in every field a careless copy of a record would carry. */
const SECRETS = {
  token: "office-session-token-0123456789abcdef0123456789abcdef",
  pinPhc: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNo",
  badgePhc: "$pbkdf2-sha256$i=600000$c2FsdA$aGFzaA",
  password: "Sup3r-Secret-Pass",
  deviceKey: "b".repeat(64),
  fingerprint: "ab".repeat(32),
  pairingCode: "K7M4-Q2XP",
};

describe("Сведения для поддержки", () => {
  it("prints exactly the allowlisted facts, in order, as plain text", () => {
    const text = buildSupportReport(FACTS, i18n.t);
    expect(text.split("\r\n")).toEqual([
      "Markiro Автоном — сведения для поддержки",
      "Сформировано (UTC): 2026-10-13T09:41:05.000Z",
      "",
      "Версия приложения: 0.1.0",
      "Сборка: a4eef5cd6, 2026-10-13",
      "Версия хоста: 0.1.0",
      "Протокол: приложение 3, хост 3, минимум хоста 3",
      "Роль компьютера: Хост и станция",
      "Система: Windows 11, x64, WebView2 130.0.2849.80",
      "Хост отвечает: да",
      "Связь с хостом: на связи",
      "Хост: https://127.0.0.1:45710 (id 3f1c2d4e)",
      "Последняя копия (UTC): 2026-10-13T08:00:00.000Z",
      "Лицензия: Лицензирование ещё не подключено",
      "",
    ]);
  });

  it("never carries a field outside the allowlist, whatever the object holds", () => {
    const polluted = { ...FACTS, ...SECRETS, session: { token: SECRETS.token } } as SupportFacts;
    const text = buildSupportReport(polluted, i18n.t);
    expect(text).toBe(buildSupportReport(FACTS, i18n.t));
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toMatch(
      /token|\bpin|badge|hash|password|fingerprint|\bkey|парол|бейдж|хеш|отпечат/i,
    );
  });

  it("hides a secret-looking value in an allowed field, and shortens the host's id", () => {
    const text = buildSupportReport(
      {
        ...FACTS,
        appVersion: SECRETS.pinPhc,
        hostVersion: SECRETS.token,
        webview: `${SECRETS.deviceKey} ${SECRETS.fingerprint}`,
        os: String.raw`C:\Users\ivanov\AppData\Local\Markiro`,
        hostAddress: "https://admin:hunter2@10.0.0.5:45710/v1/hello?token=abc#frag",
      },
      i18n.t,
    );
    for (const secret of [SECRETS.pinPhc, SECRETS.token, SECRETS.deviceKey, SECRETS.fingerprint]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("ivanov");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("token=abc");
    expect(text).toContain("Хост: https://10.0.0.5:45710 (id 3f1c2d4e)");
    expect(text).not.toContain(HOST_ID);
    expect(text).toContain("%USERPROFILE%");
  });

  it("says «неизвестно» for what it could not learn, and names the development build", () => {
    const text = buildSupportReport(
      {
        ...FACTS,
        appVersion: null,
        buildCommit: null,
        buildDate: null,
        hostVersion: null,
        hostProtocol: null,
        hostMinProtocol: null,
        role: null,
        os: null,
        arch: null,
        webview: null,
        hostReachable: false,
        linkState: null,
        hostAddress: null,
        hostId: null,
        lastBackupAt: null,
      },
      i18n.t,
    );
    expect(text).toContain("Версия приложения: неизвестно");
    expect(text).toContain("Сборка: неизвестно");
    expect(text).toContain("Протокол: приложение 3, хост неизвестно, минимум хоста неизвестно");
    expect(text).toContain("Роль компьютера: Сборка для разработки (работает как станция)");
    expect(text).toContain("Хост отвечает: нет");
    expect(text).toContain("Связь с хостом: неизвестно");
    expect(text).toContain("Хост: неизвестно");
    expect(text).toContain("Последняя копия (UTC): неизвестно");
  });

  it("shortens ids, strips addresses and cleans values", () => {
    expect(shortId(HOST_ID)).toBe("3f1c2d4e");
    expect(shortId("not-a-uuid")).toBeNull();
    expect(shortId(null)).toBeNull();
    expect(plainAddress("https://u:p@host.local:45710/x?y=1")).toBe("https://host.local:45710");
    expect(plainAddress("file:///C:/x")).toBeNull();
    expect(plainAddress("nonsense")).toBeNull();
    expect(safeValue("a\u0000b\nc\u202ed")).toBe("a b c d");
    expect(safeValue("ab ".repeat(200))).toHaveLength(121);
  });
});

describe("Блоки сведений для поддержки (точка расширения)", () => {
  const context = { t: i18n.t, facts: FACTS, about: {} as AboutData };

  it("appends the blocks after the base text, cleaned like every value", () => {
    const text = buildSupportReport(FACTS, i18n.t, [
      {
        title: "Лицензия",
        lines: [
          ["Состояние", "действует"],
          ["Номер", SECRETS.token],
          ["Папка", String.raw`C:\Users\ivanov\Documents`],
        ],
      },
    ]);
    const lines = text.split("\r\n");
    expect(lines.slice(-6)).toEqual([
      "",
      "Лицензия",
      "Состояние: действует",
      "Номер: [скрыто]",
      "Папка: %USERPROFILE%\\Documents",
      "",
    ]);
    expect(text).not.toContain(SECRETS.token);
    expect(text).not.toContain("ivanov");
  });

  it("loses only the block of a contributor that fails", async () => {
    const blocks = await collectSupportBlocks(
      [
        () => ({ title: "Первый", lines: [] }),
        () => {
          throw new Error("boom");
        },
        async () => Promise.reject(new Error("boom")),
        () => null,
        async () => ({ title: "Пятый", lines: [["a", "b"]] }),
      ],
      context,
    );
    expect(blocks.map((block) => block.title)).toEqual(["Первый", "Пятый"]);
  });

  it("has no contributors and no extra program rows until a feature adds them", () => {
    expect(SUPPORT_CONTRIBUTORS).toEqual([]);
    expect(PROGRAM_ROWS).toEqual([]);
  });
});
