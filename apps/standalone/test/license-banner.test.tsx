import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { OfficeLicense } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import {
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  INN_MISMATCH,
  licenseOf,
  RESTRICTED,
  TRIAL,
  TRIAL_ENDING,
  TRIAL_EXPIRED,
  WRONG_HOST,
} from "./support/license.js";
import {
  fakeHostApi,
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  SSCC_STATE,
  type FakeOfficeSession,
} from "./support/office.js";

function sessionWith(license: OfficeLicense): FakeOfficeSession {
  const api = fakeHostApi();
  api.getLicense.mockResolvedValue(license);
  api.getOrg.mockResolvedValue(ORG_PROFILE);
  api.getSscc.mockResolvedValue(SSCC_STATE);
  return fakeOfficeSession({ api });
}

/**
 * The office opened on a page other than «Обзор» («SSCC»: it reads neither
 * the license nor the organization's profile), where the band is shown;
 * «Обзор» carries the warnings in its own region instead.
 */
function renderPage(session: FakeOfficeSession, props: { hostRevision?: number } = {}) {
  return renderOffice(session, { initialPath: "/sscc", ...props });
}

/** The page's own heading: the page is there under the band. */
async function pageShown(): Promise<void> {
  await screen.findByRole("heading", { name: "SSCC", level: 1 });
}

/** The band above the office's pages. */
function band(): HTMLElement {
  const found = document.querySelector(".office-banner");
  if (!(found instanceof HTMLElement)) throw new Error("no license band");
  return found;
}

/** «Обзор»'s one polite region of warnings. */
function overviewAlerts(): HTMLElement {
  const found = document.querySelector("main .backup-alerts");
  if (!(found instanceof HTMLElement)) throw new Error("no overview alerts");
  return found;
}

const DISMISS = "Скрыть до конца сеанса";
const RENEWAL_TERMS = /Лицензия продлевается согласно условиям заключённой подписки\./;

/** RESTRICTED with the emergency extension running until 23.11 09:00 in Moscow. */
const EXTENDED = licenseOf({
  ...RESTRICTED,
  opensNewShifts: true,
  emergency: { available: false, until: "2027-11-23T06:00:00Z" },
});

describe("the license's band above the office's pages", () => {
  it("lays the notice out as the shared alert does: the icon on the first line, the sentence with its link inline in the text, the button in the action slot", async () => {
    renderPage(sessionWith(TRIAL));
    await pageShown();
    const alert = await waitFor(() => {
      const found = band().querySelector(".mk-alert");
      if (!(found instanceof HTMLElement)) throw new Error("no notice yet");
      return found;
    });
    // The pieces the stylesheet aligns, in the order it expects them.
    const [icon, body, action] = Array.from(alert.children);
    expect(icon?.className).toContain("mk-alert__icon");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(body?.className).toContain("mk-alert__body");
    expect(action?.className).toContain("mk-alert__action");
    // The link is part of the sentence, not of the action; the action is the one button.
    const text = body?.querySelector(".mk-alert__text");
    expect(text?.querySelector("a")?.textContent).toBe("Открыть раздел «Лицензия»");
    expect(action?.querySelectorAll("a")).toHaveLength(0);
    expect(within(action as HTMLElement).getAllByRole("button")).toHaveLength(1);
    // The link stays whole when the sentence wraps (a rule of the office's stylesheet).
    const css = readFileSync(join(__dirname, "../src/app/shell.css"), "utf8");
    expect(css).toMatch(/\.office-banner \.mk-alert__text a\s*\{[^}]*white-space: nowrap/);
  });

  it("shows the trial's days left, neutral, with a hidden word for its tone and a link", async () => {
    const session = sessionWith(TRIAL);
    renderPage(session);
    expect(
      await within(band()).findByText(
        /Пробный период: осталось 12 дн\. Загрузите файл лицензии в разделе «Информация»\./,
      ),
    ).toBeTruthy();
    expect(within(band()).getByText("Сведения:")).toBeTruthy();
    expect(band().querySelector(".mk-alert--info")).not.toBeNull();
    const link = within(band()).getByRole("link", { name: "Открыть раздел «Лицензия»" });
    expect(link.getAttribute("href")).toBe("/about#license");
    expect(within(band()).queryByText(RENEWAL_TERMS)).toBeNull();
    // No date to write: the organization's profile is not read for it.
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("is a quiet polite region, on the screen from the start, never an alert", async () => {
    renderPage(sessionWith(RESTRICTED));
    expect(band().getAttribute("aria-live")).toBe("polite");
    expect(band().getAttribute("role")).toBeNull();
    await within(band()).findByText(/лицензия площадки истекла/);
    expect(within(band()).queryAllByRole("alert")).toHaveLength(0);
    // The band never stands between the user and the page: «SSCC» is there to work with.
    await pageShown();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeTruthy();
  });

  it("hides a dismissed warning for the session, and shows the trial's last days again", async () => {
    const session = sessionWith(TRIAL);
    const view = renderPage(session, { hostRevision: 1 });
    fireEvent.click(await within(band()).findByRole("button", { name: DISMISS }));
    await waitFor(() => expect(band().childElementCount).toBe(0));
    const nav = screen.getByRole("navigation", { name: "Разделы офиса" });
    fireEvent.click(within(nav).getByRole("link", { name: "Информация" }));
    await screen.findByRole("heading", { name: "Информация", level: 1 });
    expect(band().childElementCount).toBe(0);
    // A new revision reads the license again: four days left is another warning.
    session.api.getLicense.mockResolvedValue(TRIAL_ENDING);
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} labels={quietLabelRendering()} hostRevision={2} />
      </ThemeProvider>,
    );
    expect(
      await within(band()).findByText(
        /Пробный период заканчивается 24\.10 12:00\. После этого новые смены не будут открываться без файла лицензии\./,
      ),
    ).toBeTruthy();
    expect(band().querySelector(".mk-alert--warn")).not.toBeNull();
  });

  it("keeps the grace's warning, with both dates in the organization's zone, and no «Скрыть»", async () => {
    renderPage(sessionWith(GRACE));
    expect(
      await within(band()).findByText(
        /Срок лицензии истёк 31\.10\. До 14\.11 всё работает; затем новые смены не будут открываться\./,
      ),
    ).toBeTruthy();
    expect(within(band()).getByText("Ошибка:")).toBeTruthy();
    expect(within(band()).queryByRole("button", { name: DISMISS })).toBeNull();
  });

  it.each([
    [RESTRICTED, /Новые смены не открываются: лицензия площадки истекла\./],
    [TRIAL_EXPIRED, /Новые смены не открываются: пробный период закончился\./],
    [WRONG_HOST, /Лицензия выдана другому хосту\. Сохраните запрос на активацию/],
    [INN_MISMATCH, /ИНН организации больше не совпадает с ИНН лицензии/],
  ] as const)("keeps a serious warning on every page (%#)", async (license, text) => {
    renderPage(sessionWith(license));
    expect(await within(band()).findByText(text)).toBeTruthy();
    expect(within(band()).queryByRole("button", { name: DISMISS })).toBeNull();
  });

  it("warns of the license's end and of the host's clock, both dismissible", async () => {
    renderPage(sessionWith({ ...EXPIRING, flags: { clockBehindDays: 3, clockAhead: false } }));
    expect(
      await within(band()).findByText(/Лицензия заканчивается 31\.10\.2027\. Чтобы продлить/),
    ).toBeTruthy();
    expect(
      within(band()).getByText(/Часы ПК хоста отстают от последнего известного времени на 3 дн\./),
    ).toBeTruthy();
    expect(within(band()).getAllByRole("button", { name: DISMISS })).toHaveLength(2);
  });

  it("moves the focus to the next warning's «Скрыть», then to the page, never to nowhere", async () => {
    renderPage(sessionWith({ ...EXPIRING, flags: { clockBehindDays: 3, clockAhead: false } }));
    await within(band()).findByText(/Лицензия заканчивается/);
    const [first, second] = within(band()).getAllByRole("button", { name: DISMISS });
    first!.focus();
    fireEvent.click(first!);
    await waitFor(() => expect(within(band()).queryByText(/Лицензия заканчивается/)).toBeNull());
    expect(document.activeElement).toBe(second);
    fireEvent.click(second!);
    await waitFor(() => expect(band().childElementCount).toBe(0));
    expect(document.activeElement).toBe(document.querySelector("main"));
  });

  it("moves the focus to the page when «Обзор»'s last light warning is hidden", async () => {
    renderOffice(sessionWith(TRIAL));
    const region = overviewAlerts();
    const dismiss = await within(region).findByRole("button", { name: DISMISS });
    dismiss.focus();
    fireEvent.click(dismiss);
    await waitFor(() => expect(within(region).queryByText(/Пробный период/)).toBeNull());
    expect(document.activeElement).toBe(document.querySelector("main"));
  });

  it.each([
    ["the end", EXPIRING, /Лицензия заканчивается 31\.10\.2027\./],
    ["the grace", GRACE, /Срок лицензии истёк 31\.10\./],
    ["the restriction", RESTRICTED, /лицензия площадки истекла\./],
  ] as const)(
    "adds renewal terms right after a subscription's warning of %s",
    async (_, license, text) => {
      renderPage(sessionWith(license));
      const own = await within(band()).findByText(text);
      expect(own.textContent).toMatch(new RegExp(`${text.source}.*${RENEWAL_TERMS.source}`));
      expect(within(band()).getAllByText(RENEWAL_TERMS)).toHaveLength(1);
    },
  );

  it.each([
    ["the trial ending", TRIAL_ENDING, /Пробный период заканчивается/],
    ["a demo ending", licenseOf({ ...DEMO, state: "expiring" }), /Демо-лицензия заканчивается/],
    ["the trial over", TRIAL_EXPIRED, /пробный период закончился/],
    ["a changed INN", INN_MISMATCH, /ИНН организации больше не совпадает/],
    ["another host", WRONG_HOST, /Лицензия выдана другому хосту/],
  ] as const)("adds no subscription renewal terms to %s", async (_, license, text) => {
    renderPage(sessionWith(license));
    await within(band()).findByText(text);
    expect(within(band()).queryByText(RENEWAL_TERMS)).toBeNull();
  });

  it("says the running emergency extension instead of «не открываются», still serious", async () => {
    const session = sessionWith(EXTENDED);
    renderPage(session);
    const own = await within(band()).findByText(
      /Новые смены открываются по аварийному продлению до 23\.11 09:00: лицензия площадки истекла\./,
    );
    expect(own.textContent).toMatch(RENEWAL_TERMS);
    expect(band().textContent).not.toMatch(/не открываются/);
    expect(within(band()).getByText("Ошибка:")).toBeTruthy();
    expect(band().querySelector(".mk-alert--error")).not.toBeNull();
    expect(within(band()).queryByRole("button", { name: DISMISS })).toBeNull();
    expect(within(band()).getByRole("link", { name: "Открыть раздел «Лицензия»" })).toBeTruthy();
    // The extension's end is a time: the organization's zone is read for it.
    expect(session.api.getOrg).toHaveBeenCalled();
  });

  it.each([
    [TRIAL_EXPIRED, /по аварийному продлению до 23\.11 09:00: пробный период закончился\./],
    [INN_MISMATCH, /по аварийному продлению до 23\.11 09:00: ИНН организации больше не совпадает/],
  ] as const)("says the extension under another refusal too (%#)", async (license, text) => {
    renderPage(
      sessionWith(
        licenseOf({
          ...license,
          opensNewShifts: true,
          emergency: { available: false, until: "2027-11-23T06:00:00Z" },
        }),
      ),
    );
    expect(await within(band()).findByText(text)).toBeTruthy();
    expect(band().textContent).not.toMatch(/не открываются/);
  });

  it("is empty and reads nothing more while the license is well or the host is silent", async () => {
    const session = sessionWith(ACTIVE_LICENSE);
    renderPage(session);
    await pageShown();
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalled());
    expect(band().childElementCount).toBe(0);
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("is empty when the host does not answer", async () => {
    const session = sessionWith(ACTIVE_LICENSE);
    session.api.getLicense.mockRejectedValue(new Error("down"));
    renderPage(session);
    await pageShown();
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalled());
    expect(band().childElementCount).toBe(0);
  });

  it("keeps the last warning when a re-read fails, instead of flickering out", async () => {
    const session = sessionWith(RESTRICTED);
    const view = renderPage(session, { hostRevision: 1 });
    const own = await within(band()).findByText(/лицензия площадки истекла/);
    session.api.getLicense.mockRejectedValue(new Error("down"));
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} labels={quietLabelRendering()} hostRevision={2} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalledTimes(2));
    // Let the failed answer settle: the same node stays, so it is not heard again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(band()).getByText(/лицензия площадки истекла/)).toBe(own);
  });

  it("leads to «Лицензия» on «Информация» and gives the focus to that section", async () => {
    renderPage(sessionWith(RESTRICTED));
    fireEvent.click(await within(band()).findByRole("link", { name: "Открыть раздел «Лицензия»" }));
    await screen.findByRole("heading", { name: "Информация", level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("license")));
  });

  it("gives the focus to «Лицензия» again from «Информация» itself", async () => {
    renderOffice(sessionWith(RESTRICTED), { initialPath: "/about" });
    await screen.findByRole("heading", { name: "Информация", level: 1 });
    const link = await within(band()).findByRole("link", { name: "Открыть раздел «Лицензия»" });
    link.focus();
    fireEvent.click(link);
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("license")));
  });

  it("is repeated on «Обзор» in its one polite region, without «Скрыть»", async () => {
    renderOffice(sessionWith(licenseOf({ ...RESTRICTED })));
    const region = overviewAlerts();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(
      await within(region).findByText(/Новые смены не открываются: лицензия площадки истекла\./),
    ).toBeTruthy();
    expect(within(region).getAllByText(RENEWAL_TERMS)).toHaveLength(1);
    expect(within(region).queryByRole("button", { name: DISMISS })).toBeNull();
    expect(within(region).queryAllByRole("alert")).toHaveLength(0);
  });

  it("shows each warning exactly once on «Обзор»: in its own region, never in the band", async () => {
    renderOffice(sessionWith({ ...EXPIRING, flags: { clockBehindDays: 3, clockAhead: false } }));
    const region = overviewAlerts();
    await within(region).findByText(/Лицензия заканчивается 31\.10\.2027\./);
    await within(region).findByText(/Часы ПК хоста отстают/);
    expect(band().childElementCount).toBe(0);
    // One alert per warning in the page's region: the end and the clock (the license card
    // beside it says the state in words, which is not a warning).
    expect(region.querySelectorAll(".mk-alert")).toHaveLength(2);
    expect(screen.getAllByText(/Лицензия заканчивается 31\.10\.2027\./)).toHaveLength(1);
    expect(screen.getAllByText(RENEWAL_TERMS)).toHaveLength(1);
  });

  it("shows the band on the next page after «Обзор»", async () => {
    renderOffice(sessionWith(RESTRICTED));
    await within(overviewAlerts()).findByText(/лицензия площадки истекла/);
    expect(band().childElementCount).toBe(0);
    const nav = screen.getByRole("navigation", { name: "Разделы офиса" });
    fireEvent.click(within(nav).getByRole("link", { name: "SSCC" }));
    await pageShown();
    expect(await within(band()).findByText(/лицензия площадки истекла/)).toBeTruthy();
    expect(screen.getAllByText(/лицензия площадки истекла/)).toHaveLength(1);
    // Back on «Обзор»: the band empties, the page's region carries the warning.
    fireEvent.click(within(nav).getByRole("link", { name: "Обзор" }));
    await within(overviewAlerts()).findByText(/лицензия площадки истекла/);
    expect(band().childElementCount).toBe(0);
    expect(screen.getAllByText(/лицензия площадки истекла/)).toHaveLength(1);
  });

  it("hides a warning dismissed on «Обзор» on the band too, for the session", async () => {
    renderOffice(sessionWith(TRIAL));
    const region = overviewAlerts();
    await within(region).findByText(/Пробный период: осталось 12 дн\./);
    fireEvent.click(within(region).getByRole("button", { name: DISMISS }));
    await waitFor(() => expect(within(region).queryByText(/Пробный период/)).toBeNull());
    const nav = screen.getByRole("navigation", { name: "Разделы офиса" });
    fireEvent.click(within(nav).getByRole("link", { name: "SSCC" }));
    await pageShown();
    // The page has read its data: the band, read from the same cache, would be there by now.
    await screen.findAllByRole("button", { name: "Сохранить" });
    expect(band().childElementCount).toBe(0);
  });

  it("hides a warning dismissed on the band on «Обзор» too, for the session", async () => {
    renderPage(sessionWith(TRIAL));
    fireEvent.click(await within(band()).findByRole("button", { name: DISMISS }));
    await waitFor(() => expect(band().childElementCount).toBe(0));
    const nav = screen.getByRole("navigation", { name: "Разделы офиса" });
    fireEvent.click(within(nav).getByRole("link", { name: "Обзор" }));
    await screen.findByRole("heading", { name: "Обзор", level: 1 });
    expect(within(overviewAlerts()).queryByText(/Пробный период/)).toBeNull();
    // The license card names the state («Пробный период»); the warning is the text with the days.
    expect(screen.queryByText(/Пробный период: осталось/)).toBeNull();
  });

  it("repeats the running extension on «Обзор», never «не открываются»", async () => {
    renderOffice(sessionWith(EXTENDED));
    const region = overviewAlerts();
    expect(
      await within(region).findByText(/Новые смены открываются по аварийному продлению до 23\.11/),
    ).toBeTruthy();
    expect(region.textContent).not.toMatch(/не открываются/);
    expect(within(region).getAllByText(RENEWAL_TERMS)).toHaveLength(1);
  });
});
