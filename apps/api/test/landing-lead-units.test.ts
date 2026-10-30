import { describe, expect, it, vi } from "vitest";
import { rateLimitedError } from "../src/modules/demo-requests/demo-request.errors";
import { landingLeadBodySchema } from "../src/modules/landing-leads/landing-lead.schema";
import { LandingLeadService } from "../src/modules/landing-leads/landing-lead.service";
import {
  civilDate,
  digestIsEmpty,
  minusDays,
  selectDigestSections,
  type LeadDigestCandidate,
} from "../src/modules/landing-leads/lead-digest-sections";
import { leadAlertText, leadDigestText } from "../src/modules/landing-leads/lead-telegram-message";
import {
  TelegramClient,
  TelegramSendError,
  telegramConfigFromEnv,
  telegramTargetsFromEnv,
} from "../src/modules/landing-leads/telegram.client";
import {
  digestRequestId,
  retryDelaySeconds,
} from "../src/modules/landing-leads/landing-lead-jobs.service";
import type { Env } from "../src/env";

const CONSENT = "MKR-PD-02/2026.10/01";

function body(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    locale: "ru",
    sourcePath: "/skachat/",
    intent: "download",
    email: " Buyer@Example.TEST ",
    company: " ООО «Пивоварня» ",
    consentVersion: CONSENT,
    website: "",
    captchaToken: "token",
    ...overrides,
  };
}

describe("landing lead body (spec §15.3)", () => {
  it("accepts a lead without a captcha token", () => {
    const withoutCaptcha: Record<string, unknown> = body();
    delete withoutCaptcha.captchaToken;
    expect(landingLeadBodySchema.safeParse(withoutCaptcha).success).toBe(true);
  });

  it("normalizes the request id, e-mail and a Russian phone and drops empty fields", () => {
    const parsed = landingLeadBodySchema.parse(
      body({ phone: "8 (999) 123-45-67", name: "", utm: { source: "yandex", medium: "" } }),
    );
    expect(parsed).toMatchObject({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "buyer@example.test",
      company: "ООО «Пивоварня»",
      phone: "+79991234567",
    });
    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("captchaToken");
  });

  it("rejects a malformed phone, an unknown path and an invoice without INN", () => {
    for (const candidate of [
      body({ phone: "12345" }),
      body({ sourcePath: "/faq/" }),
      body({ intent: "invoice", tariffCode: "line" }),
      body({ extra: 1 }),
    ]) {
      expect(landingLeadBodySchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("discards optional attribution from old clients before persistence", () => {
    const parsed = landingLeadBodySchema.parse(
      body({
        utm: { source: "yandex", campaign: "private" },
        referrer: "https://external.example/private?q=person",
      }),
    );
    expect(parsed).not.toHaveProperty("utm");
    expect(parsed).not.toHaveProperty("referrer");
  });
});

describe("LandingLeadService defenses", () => {
  function service(
    overrides: {
      enabled?: boolean;
      limited?: boolean;
      failing?: boolean;
    } = {},
  ) {
    const accept = vi.fn(async () => {
      if (overrides.failing) throw new Error("private database detail");
    });
    return {
      accept,
      service: new LandingLeadService(
        { enabled: overrides.enabled ?? true },
        {
          assertAllowed: () => {
            if (overrides.limited) throw rateLimitedError();
          },
        },
        { accept },
      ),
    };
  }
  const input = () => landingLeadBodySchema.parse(body());

  it("awaits durable rate admission before storing a lead", async () => {
    let admit: () => void = () => {
      throw new Error("gate not initialized");
    };
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const accept = vi.fn(async () => undefined);
    const subject = new LandingLeadService(
      { enabled: true },
      { assertAllowed: () => gate },
      { accept },
    );
    const pending = subject.submit(input(), "203.0.113.7");
    await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
    admit();
    await pending;
    expect(accept).toHaveBeenCalledOnce();
  });

  it("does not store a lead when asynchronous admission rejects", async () => {
    const accept = vi.fn(async () => undefined);
    const subject = new LandingLeadService(
      { enabled: true },
      {
        assertAllowed: async () => {
          throw rateLimitedError();
        },
      },
      { accept },
    );
    await expect(subject.submit(input(), "203.0.113.7")).rejects.toMatchObject({ status: 429 });
    expect(accept).not.toHaveBeenCalled();
  });

  it("stores an accepted form and echoes its request id", async () => {
    const { service: subject, accept } = service();
    await expect(subject.submit(input(), "203.0.113.7")).resolves.toEqual({
      accepted: true,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(accept).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled", { enabled: false }, 404, "submission_disabled"],
    ["rate limited", { limited: true }, 429, "rate_limited"],
    ["storage", { failing: true }, 503, "submission_unavailable"],
  ])("refuses %s with the public code", async (_case, overrides, status, code) => {
    const { service: subject } = service(overrides);
    await expect(subject.submit(input(), "203.0.113.7")).rejects.toMatchObject({
      status,
      response: { code },
    });
  });

  it("refuses a filled honeypot and a stale consent before storage", async () => {
    for (const candidate of [
      landingLeadBodySchema.parse(body({ website: "spam" })),
      landingLeadBodySchema.parse(body({ consentVersion: "MKR-PD-02/2025.01/01" })),
    ]) {
      const { service: subject, accept } = service();
      await expect(subject.submit(candidate, "203.0.113.7")).rejects.toMatchObject({
        status: 400,
        response: { code: "invalid_request" },
      });
      expect(accept).not.toHaveBeenCalled();
    }
  });
});

describe("Telegram client (spec §15.4)", () => {
  const config = { botToken: "42:fake-bot-token-for-tests-only", chatId: "-1001234" };

  it("posts to api.telegram.org without following redirects and with a timeout", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await new TelegramClient(config, fetcher as unknown as typeof fetch).sendMessage("Привет");
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://api.telegram.org");
    expect(url.pathname).toBe(`/bot${config.botToken}/sendMessage`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: "-1001234",
      text: "Привет",
      disable_web_page_preview: true,
    });
  });

  it.each([
    [429, "telegram_rate_limited", true],
    [502, "telegram_unavailable", true],
    [401, "telegram_rejected_401", false],
    [400, "telegram_rejected_400", false],
  ])("classifies HTTP %i", async (status, code, transient) => {
    const fetcher = vi.fn(async () => new Response("{}", { status }));
    const error = await new TelegramClient(config, fetcher as unknown as typeof fetch)
      .sendMessage("x")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramSendError);
    expect(error).toMatchObject({ code, transient });
    expect(String((error as Error).message)).not.toContain(config.botToken);
  });

  it("hides the network error, whose URL would carry the token", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError(`fetch failed https://api.telegram.org/bot${config.botToken}/x`);
    });
    const error = await new TelegramClient(config, fetcher as unknown as typeof fetch)
      .sendMessage("x")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "telegram_network", transient: true });
    expect(JSON.stringify(error)).not.toContain(config.botToken);
    expect((error as Error).message).not.toContain(config.botToken);
  });

  it("stays silent unless the flag and both secrets are set", () => {
    const env = (values: Partial<Env>) => values as Env;
    expect(telegramConfigFromEnv(env({ LEAD_TELEGRAM_ENABLED: false, ...withSecrets() }))).toBe(
      null,
    );
    expect(telegramConfigFromEnv(env({ LEAD_TELEGRAM_ENABLED: true }))).toBe(null);
    expect(telegramConfigFromEnv(env({ LEAD_TELEGRAM_ENABLED: true, ...withSecrets() }))).toEqual(
      config,
    );
  });

  it.each([
    ["42", "-1001234", ["42", "-1001234"]],
    [undefined, "-1001234", ["-1001234"]],
    ["42", undefined, ["42"]],
    ["00042", "42", ["42"]],
    ["@Markiro_Leads", "@markiro_leads", ["@markiro_leads"]],
  ])("builds and deduplicates recipients %s / %s", async (primary, group, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const targets = telegramTargetsFromEnv(
      {
        LEAD_TELEGRAM_ENABLED: true,
        LEAD_TELEGRAM_BOT_TOKEN: config.botToken,
        LEAD_TELEGRAM_CHAT_ID: primary,
        LEAD_TELEGRAM_GROUP_CHAT_ID: group,
      } as Env,
      fetcher,
    );
    expect(targets).toHaveLength(expected.length);
    expect(fetcher).not.toHaveBeenCalled();
    for (const target of targets ?? []) {
      expect(target.id).toMatch(/^[a-f0-9]{64}$/);
      await target.sender.sendMessage("test");
    }
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).chat_id)).toEqual(
      expected,
    );
  });

  it("does not construct active recipients while disabled or without a token", () => {
    expect(
      telegramTargetsFromEnv({
        LEAD_TELEGRAM_ENABLED: false,
        ...withSecrets(),
        LEAD_TELEGRAM_GROUP_CHAT_ID: "-1001234",
      } as Env),
    ).toBeNull();
    expect(
      telegramTargetsFromEnv({
        LEAD_TELEGRAM_ENABLED: true,
        LEAD_TELEGRAM_GROUP_CHAT_ID: "-1001234",
      } as Env),
    ).toBeNull();
  });

  function withSecrets() {
    return { LEAD_TELEGRAM_BOT_TOKEN: config.botToken, LEAD_TELEGRAM_CHAT_ID: config.chatId };
  }
});

describe("Telegram notifications contain only fixed service text and counts", () => {
  it("does not send free text, attribution, identifiers or card links", () => {
    const facts = {
      kind: "invoice_request" as const,
      firstContact: false,
      company: "ИП Иванов Иван Иванович",
      productGroup: "Пётр, Москва, улица Примерная",
      linesBucket: "1",
      tariffCode: "buyer@example.test",
      sourcePath: "/Иванов/",
      utm: { source: "личные сведения" },
      leadUrl: "https://admin.markiro.app/leads/private-id",
    };
    expect(leadAlertText(facts)).toBe(
      "Повторное обращение · запрос счёта\nОткройте раздел «Заявки» в панели управления.",
    );
  });

  it("reports digest counts without companies or links", () => {
    const text = leadDigestText("2026-10-21", {
      new_uncontacted: [{ company: "ИП Иванов", leadUrl: "https://private/lead-id" }],
      day_3: [],
      day_10: [],
      touch_due: [],
      invoice_unpaid: [],
    });
    expect(text).toBe(
      "Кому пора написать · 21.10.2026\n\nНовые без контакта (1)\n\nОткройте раздел «Заявки» в панели управления.",
    );
  });
});

describe("digest sections (spec §15.5)", () => {
  // 2026-10-21 06:00 UTC = 09:00 MSK.
  const now = new Date("2026-10-21T06:00:00.000Z");
  const at = (iso: string) => new Date(iso);
  function lead(overrides: Partial<LeadDigestCandidate>): LeadDigestCandidate {
    return {
      id: overrides.id ?? "lead",
      company: "Завод",
      status: "new",
      createdAt: at("2026-10-21T05:00:00.000Z"),
      statusChangedAt: at("2026-10-21T05:00:00.000Z"),
      nextTouchAt: null,
      firstDownloadAt: null,
      ...overrides,
    };
  }

  it("uses Moscow civil days", () => {
    expect(civilDate(at("2026-10-20T21:30:00.000Z"))).toBe("2026-10-21");
    expect(minusDays("2026-03-01", 1)).toBe("2026-02-28");
    expect(minusDays("2028-03-01", 1)).toBe("2028-02-29");
  });

  it("selects each section by its own rule", () => {
    const sections = selectDigestSections(
      [
        lead({ id: "fresh-new", createdAt: at("2026-10-20T08:00:00.000Z") }),
        lead({ id: "old-new", createdAt: at("2026-10-19T08:00:00.000Z") }),
        lead({
          id: "day3",
          status: "contacted",
          createdAt: at("2026-10-18T07:00:00.000Z"),
          firstDownloadAt: at("2026-10-18T07:00:00.000Z"),
        }),
        lead({
          id: "day3-trial",
          status: "trial",
          firstDownloadAt: at("2026-10-18T07:00:00.000Z"),
        }),
        lead({
          id: "day10",
          status: "trial",
          firstDownloadAt: at("2026-10-11T10:00:00.000Z"),
        }),
        lead({ id: "touch", status: "contacted", nextTouchAt: at("2026-10-21T20:00:00.000Z") }),
        lead({
          id: "touch-later",
          status: "contacted",
          nextTouchAt: at("2026-10-21T21:30:00.000Z"),
        }),
        lead({
          id: "unpaid",
          status: "invoice_sent",
          statusChangedAt: at("2026-10-13T06:00:00.000Z"),
        }),
        lead({
          id: "recent-invoice",
          status: "invoice_sent",
          statusChangedAt: at("2026-10-15T06:00:00.000Z"),
        }),
        lead({ id: "won", status: "won", createdAt: at("2026-10-01T06:00:00.000Z") }),
      ],
      now,
    );
    const ids = Object.fromEntries(
      Object.entries(sections).map(([key, leads]) => [key, leads.map((entry) => entry.id)]),
    );
    expect(ids).toEqual({
      new_uncontacted: ["old-new"],
      day_3: ["day3"],
      day_10: ["day10"],
      touch_due: ["touch"],
      invoice_unpaid: ["unpaid"],
    });
  });

  it("drops a lead whose next touch is after today from every section", () => {
    const sections = selectDigestSections(
      [
        lead({
          id: "postponed",
          createdAt: at("2026-10-10T06:00:00.000Z"),
          firstDownloadAt: at("2026-10-11T06:00:00.000Z"),
          nextTouchAt: at("2026-10-24T06:00:00.000Z"),
        }),
      ],
      now,
    );
    expect(digestIsEmpty(sections)).toBe(true);
  });
});

describe("lead job helpers", () => {
  it("backs off exponentially to an hour", () => {
    expect([1, 2, 3, 4, 8, 9].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 3600, 3600]);
  });

  it("derives one stable UUID per digest day", () => {
    expect(digestRequestId("2026-10-21")).toBe(digestRequestId("2026-10-21"));
    expect(digestRequestId("2026-10-21")).not.toBe(digestRequestId("2026-10-22"));
    expect(digestRequestId("2026-10-21")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
