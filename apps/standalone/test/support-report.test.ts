import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

import i18n from "i18next";
import { describe, expect, it } from "vitest";

import { decryptBlob, findBlob } from "../../../tools/standalone-support/decrypt.mjs";
import { HostError } from "../src/host/client.js";
import { usageStatsSchema } from "../src/host/usage-stats.js";
import type { AboutData } from "../src/office/info/about-data.js";
import { PROGRAM_ROWS } from "../src/office/info/ProgramSection.js";
import { collectSupportBlocks, SUPPORT_CONTRIBUTORS } from "../src/office/info/support-blocks.js";
import type { SupportKeyset } from "../src/office/info/support-keys.js";
import {
  createUsageContributor,
  usageLoadOf,
  usagePayload,
  type UsageLoad,
} from "../src/office/info/support-usage.js";
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

  it("has the usage statistics as its one contributor and no extra program rows", () => {
    expect(SUPPORT_CONTRIBUTORS).toHaveLength(1);
    expect(PROGRAM_ROWS).toEqual([]);
  });
});

// Bound first: Vite rewrites the literal `new URL(..., import.meta.url)` (see protocol.test.ts).
const testModuleUrl = import.meta.url;

describe("Статистика использования в сведениях для поддержки (бета 3)", () => {
  const stats = usageStatsSchema.parse(
    JSON.parse(readFileSync(new URL("../proto/fixtures/usage-stats.json", testModuleUrl), "utf8")),
  );
  const context = (usage?: UsageLoad) => ({
    t: i18n.t,
    facts: FACTS,
    about: {} as AboutData,
    ...(usage === undefined ? {} : { usage }),
  });
  const keyset = (): { pem: string; keyset: SupportKeyset } => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    return {
      pem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
      keyset: {
        keys: [{ kid: "sup-t1", jwk: { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" } }],
        retiredKids: [],
      },
    };
  };

  it("puts the counts into the text only as one opaque token, under a neutral label", async () => {
    const { pem, keyset: keys } = keyset();
    const block = await createUsageContributor(keys)(context({ kind: "ok", stats }));
    expect(block?.title).toBe("Данные для анализа");
    expect(block?.lines).toEqual([["", "Зашифрованные данные"]]);
    const text = buildSupportReport(FACTS, i18n.t, block === null ? [] : [block]);
    const lines = text.split("\r\n");
    expect(lines.slice(-4, -1)).toEqual([
      "Данные для анализа",
      "Зашифрованные данные",
      block?.opaque,
    ]);
    expect(text).not.toContain("Статистика");
    // No count and no field name of the statistics is readable in the text.
    for (const word of ["21640", "7020", "accepted", "scans", "boxes", "1802", "shifts"]) {
      expect(text).not.toContain(word);
    }
    // And the maker's tool opens the token to the allowlisted JSON.
    const opened = decryptBlob(findBlob(text), pem);
    expect(opened.json).toMatchObject({
      v: 1,
      generatedAt: "2026-10-13T09:41:05.000Z",
      appVersion: "0.1.0",
      hostVersion: "0.1.0",
      devices: { station: 3, office: 2, handheld: 1 },
    });
    expect((opened.json as { months: unknown[] }).months).toHaveLength(12);
  });

  it("builds the payload by an allowlist: a field the host's answer holds beyond it cannot reach the token", async () => {
    const polluted = {
      ...stats,
      secretName: "Молоко ООО Север",
      months: stats.months.map((month) => ({
        ...month,
        productName: "Молоко",
        shifts: { ...month.shifts, operatorPin: "123456" },
      })),
    } as typeof stats;
    const payload = usagePayload(polluted, {
      generatedAt: FACTS.generatedAt,
      appVersion: FACTS.appVersion,
      hostVersion: FACTS.hostVersion,
    });
    expect(payload).toBe(
      usagePayload(stats, {
        generatedAt: FACTS.generatedAt,
        appVersion: FACTS.appVersion,
        hostVersion: FACTS.hostVersion,
      }),
    );
    for (const word of ["Молоко", "Север", "123456", "productName", "secretName", "operatorPin"]) {
      expect(payload).not.toContain(word);
    }
    // Every leaf of the payload is a count, a month key, a date or a version.
    const keys = new Set<string>();
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) value.forEach((item) => walk(item, `${path}[]`));
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(`${path}.${key}`);
          walk(inner, `${path}.${key}`);
        }
      }
    };
    walk(JSON.parse(payload), "");
    expect(
      [...keys].filter((key) =>
        /name|pin|badge|hash|code(?!s)|sscc|gtin|password|token/iu.test(key),
      ),
    ).toEqual([]);
    expect([...keys].sort()).toEqual(
      [...new Set(Object.keys(JSON.parse(payload) as object).map((key) => `.${key}`))]
        .concat([...keys].filter((key) => key.includes(".months[].") || key.includes(".devices.")))
        .filter((key, at, all) => all.indexOf(key) === at)
        .sort(),
    );
  });

  it("says why there are no statistics instead of printing them: no key, not an administrator, no answer", async () => {
    const empty = createUsageContributor({ keys: [], retiredKids: [] });
    // A build without a key never prints counts, whatever the host answered.
    expect((await empty(context({ kind: "ok", stats })))?.lines).toEqual([["", "Отсутствуют"]]);
    expect((await empty(context({ kind: "ok", stats })))?.opaque).toBeUndefined();
    const { keyset: keys } = keyset();
    const contributor = createUsageContributor(keys);
    expect((await contributor(context({ kind: "forbidden" })))?.lines).toEqual([
      ["", "Отсутствуют"],
    ]);
    expect((await contributor(context({ kind: "failed" })))?.lines).toEqual([["", "Отсутствуют"]]);
    expect(await contributor(context())).toBeNull();
    const refused = usageLoadOf({
      status: "rejected",
      reason: new HostError({
        kind: "api",
        code: "forbidden",
        status: 403,
        message: "forbidden",
        details: {},
      }),
    });
    expect(refused).toEqual({ kind: "forbidden" });
    expect(usageLoadOf({ status: "rejected", reason: new Error("down") })).toEqual({
      kind: "failed",
    });
    expect(usageLoadOf({ status: "fulfilled", value: stats })).toEqual({ kind: "ok", stats });
  });

  it("carries a token only of the token's shape, never free text", () => {
    const text = buildSupportReport(FACTS, i18n.t, [
      { title: "Блок", lines: [], opaque: "МОЛОКО 123456 это не токен" },
      { title: "Второй", lines: [], opaque: `MKS1.sup-t1.${"B".repeat(40)}` },
      { title: "Третий", lines: [], opaque: `MKS1.sup-t1.${"A".repeat(200)}` },
    ]);
    expect(text).not.toContain("МОЛОКО");
    expect(text).not.toContain("B".repeat(40));
    expect(text).toContain(`MKS1.sup-t1.${"A".repeat(200)}`);
  });
});
