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
  type FakeOfficeSession,
} from "./support/office.js";

function sessionWith(license: OfficeLicense): FakeOfficeSession {
  const api = fakeHostApi();
  api.getLicense.mockResolvedValue(license);
  api.getOrg.mockResolvedValue(ORG_PROFILE);
  return fakeOfficeSession({ api });
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
const FREE_RENEWAL = /Новый файл по истечении срока бесплатно запрашивается у нас\./;

/** RESTRICTED with the emergency extension running until 23.11 09:00 in Moscow. */
const EXTENDED = licenseOf({
  ...RESTRICTED,
  opensNewShifts: true,
  emergency: { available: false, until: "2027-11-23T06:00:00Z" },
});

describe("the license's band above the office's pages", () => {
  it("shows the trial's days left, neutral, with a hidden word for its tone and a link", async () => {
    const session = sessionWith(TRIAL);
    renderOffice(session);
    expect(
      await within(band()).findByText(
        /Пробный период: осталось 12 дн\. Загрузите файл лицензии в разделе «Информация»\./,
      ),
    ).toBeTruthy();
    expect(within(band()).getByText("Сведения:")).toBeTruthy();
    expect(band().querySelector(".mk-alert--info")).not.toBeNull();
    const link = within(band()).getByRole("link", { name: "Открыть раздел «Лицензия»" });
    expect(link.getAttribute("href")).toBe("/about#license");
    expect(within(band()).queryByText(FREE_RENEWAL)).toBeNull();
    // No date to write: the organization's profile is not read for it.
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("is a quiet polite region, on the screen from the start, never an alert", async () => {
    renderOffice(sessionWith(RESTRICTED));
    expect(band().getAttribute("aria-live")).toBe("polite");
    expect(band().getAttribute("role")).toBeNull();
    await within(band()).findByText(/лицензия площадки истекла/);
    expect(within(band()).queryAllByRole("alert")).toHaveLength(0);
    // The band never stands between the user and the page: «Обзор» is there to work with.
    expect(screen.getByRole("heading", { name: "Офис", level: 1 })).toBeTruthy();
    expect(screen.getByText(/Вы вошли как/)).toBeTruthy();
  });

  it("hides a dismissed warning for the session, and shows the trial's last days again", async () => {
    const session = sessionWith(TRIAL);
    const view = renderOffice(session, { hostRevision: 1 });
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
        /Пробный период заканчивается 24\.10\. После этого новые смены не будут открываться без файла лицензии\./,
      ),
    ).toBeTruthy();
    expect(band().querySelector(".mk-alert--warn")).not.toBeNull();
  });

  it("keeps the grace's warning, with both dates in the organization's zone, and no «Скрыть»", async () => {
    renderOffice(sessionWith(GRACE));
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
    renderOffice(sessionWith(license));
    expect(await within(band()).findByText(text)).toBeTruthy();
    expect(within(band()).queryByRole("button", { name: DISMISS })).toBeNull();
  });

  it("warns of the license's end and of the host's clock, both dismissible", async () => {
    renderOffice(sessionWith({ ...EXPIRING, flags: { clockBehindDays: 3, clockAhead: false } }));
    expect(
      await within(band()).findByText(/Лицензия заканчивается 31\.10\.2027\. Чтобы продлить/),
    ).toBeTruthy();
    expect(
      within(band()).getByText(/Часы ПК хоста отстают от последнего известного времени на 3 дн\./),
    ).toBeTruthy();
    expect(within(band()).getAllByRole("button", { name: DISMISS })).toHaveLength(2);
  });

  it.each([
    ["the end", EXPIRING, /Лицензия заканчивается 31\.10\.2027\./],
    ["the grace", GRACE, /Срок лицензии истёк 31\.10\./],
    ["the restriction", RESTRICTED, /лицензия площадки истекла\./],
  ] as const)(
    "adds the free new file right after a subscription's warning of %s",
    async (_, license, text) => {
      renderOffice(sessionWith(license));
      const own = await within(band()).findByText(text);
      expect(own.textContent).toMatch(
        new RegExp(`${text.source}.*Новый файл по истечении срока бесплатно`),
      );
      expect(within(band()).getAllByText(FREE_RENEWAL)).toHaveLength(1);
    },
  );

  it.each([
    ["the trial ending", TRIAL_ENDING, /Пробный период заканчивается/],
    ["a demo ending", licenseOf({ ...DEMO, state: "expiring" }), /Демо-лицензия заканчивается/],
    ["the trial over", TRIAL_EXPIRED, /пробный период закончился/],
    ["a changed INN", INN_MISMATCH, /ИНН организации больше не совпадает/],
    ["another host", WRONG_HOST, /Лицензия выдана другому хосту/],
  ] as const)("adds no free new file to %s", async (_, license, text) => {
    renderOffice(sessionWith(license));
    await within(band()).findByText(text);
    expect(within(band()).queryByText(FREE_RENEWAL)).toBeNull();
  });

  it("says the running emergency extension instead of «не открываются», still serious", async () => {
    const session = sessionWith(EXTENDED);
    renderOffice(session);
    const own = await within(band()).findByText(
      /Новые смены открываются по аварийному продлению до 23\.11 09:00: лицензия площадки истекла\./,
    );
    expect(own.textContent).toMatch(FREE_RENEWAL);
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
    renderOffice(
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
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalled());
    expect(band().childElementCount).toBe(0);
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("is empty when the host does not answer", async () => {
    const session = sessionWith(ACTIVE_LICENSE);
    session.api.getLicense.mockRejectedValue(new Error("down"));
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalled());
    expect(band().childElementCount).toBe(0);
  });

  it("keeps the last warning when a re-read fails, instead of flickering out", async () => {
    const session = sessionWith(RESTRICTED);
    const view = renderOffice(session, { hostRevision: 1 });
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
    renderOffice(sessionWith(RESTRICTED));
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
    expect(within(region).getAllByText(FREE_RENEWAL)).toHaveLength(1);
    expect(within(region).queryByRole("button", { name: DISMISS })).toBeNull();
    expect(within(region).queryAllByRole("alert")).toHaveLength(0);
  });

  it("repeats the running extension on «Обзор», never «не открываются»", async () => {
    renderOffice(sessionWith(EXTENDED));
    const region = overviewAlerts();
    expect(
      await within(region).findByText(/Новые смены открываются по аварийному продлению до 23\.11/),
    ).toBeTruthy();
    expect(region.textContent).not.toMatch(/не открываются/);
    expect(within(region).getAllByText(FREE_RENEWAL)).toHaveLength(1);
  });
});
