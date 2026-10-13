import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostStatus } from "../src/host/protocol.js";
import { PROTOCOL_VERSION } from "../src/host/protocol.js";
import { ExternalLinkError, type AboutApi } from "../src/office/info/about-api.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import { AboutPage } from "../src/office/info/AboutPage.js";
import { ABOUT_SECTIONS } from "../src/office/info/sections.js";
import { OfficeFilesProvider } from "../src/office/exports/office-files-context.js";
import { OfficeLinkProvider } from "../src/office/office-link.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";
import { DEVICE_STATUS, HOST_ID, observation } from "./support/fixtures.js";
import { fakeOfficeSession, renderOffice, TECHNOLOGIST } from "./support/office.js";

type FakeAbout = { [K in keyof AboutApi]: Mock<AboutApi[K]> };

function fakeAbout(overrides: Partial<FakeAbout> = {}): FakeAbout {
  return {
    appVersion: vi.fn<AboutApi["appVersion"]>(async () => "0.1.0"),
    installRole: vi.fn<AboutApi["installRole"]>(async () => "host"),
    pairing: vi.fn<AboutApi["pairing"]>(async () => DEVICE_STATUS),
    hello: vi.fn<AboutApi["hello"]>(async () => observation(true)),
    system: vi.fn<AboutApi["system"]>(async () => ({
      os: "Windows 11",
      arch: "x64",
      webview: "WebView2 130.0.2849.80",
    })),
    openLink: vi.fn<AboutApi["openLink"]>(async () => undefined),
    ...overrides,
  };
}

const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };

function renderAbout(
  about: FakeAbout,
  files: FakeOfficeFiles = fakeOfficeFiles(),
  link: HostStatus | null = ONLINE,
) {
  const session = fakeOfficeSession();
  const view = render(
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <OfficeLinkProvider value={{ status: link, sync: null }}>
            <OfficeFilesProvider value={files}>
              <AboutProvider value={about}>
                <AboutPage />
              </AboutProvider>
            </OfficeFilesProvider>
          </OfficeLinkProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { session, files, ...view };
}

function card(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title, level: 2 });
  const found = heading.closest(".mk-card");
  if (!(found instanceof HTMLElement)) throw new Error(`no card ${title}`);
  return found;
}

/** The text a term's description holds, in a card's definition grid. */
function described(within_: HTMLElement, term: string): string {
  const dt = within(within_).getByText(term, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

describe("Информация", () => {
  it("shows the program, the host, the protocol, the role and the system", async () => {
    renderAbout(fakeAbout());
    await screen.findByRole("heading", { name: "Информация", level: 1 });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const program = card("О программе");
    expect(described(program, "Продукт")).toBe("Markiro Автоном");
    expect(described(program, "Версия приложения")).toBe("0.1.0");
    expect(described(program, "Версия хоста")).toBe("0.1.0");
    expect(described(program, "Версия протокола")).toBe(
      `${PROTOCOL_VERSION} (хост: ${PROTOCOL_VERSION}, не ниже 1)`,
    );
    expect(described(program, "Роль этого компьютера")).toBe("Хост и станция");
    expect(described(program, "Система")).toBe("Windows 11, x64, WebView2 130.0.2849.80");
  });

  it("says so when the host does not answer, and when the role cannot be read", async () => {
    const about = fakeAbout({
      hello: vi.fn<AboutApi["hello"]>(async () => {
        throw new Error("unreachable");
      }),
      installRole: vi.fn<AboutApi["installRole"]>(async () => {
        throw new Error("no shell");
      }),
      appVersion: vi.fn<AboutApi["appVersion"]>(async () => {
        throw new Error("no shell");
      }),
    });
    renderAbout(about);
    await screen.findByText("хост не отвечает");
    const program = card("О программе");
    expect(described(program, "Версия приложения")).toBe("неизвестно");
    expect(described(program, "Версия протокола")).toBe(String(PROTOCOL_VERSION));
    expect(described(program, "Роль этого компьютера")).toBe("не удалось определить");
  });

  it("asks the host the pairing names, else the one on this computer", async () => {
    const about = fakeAbout({ pairing: vi.fn<AboutApi["pairing"]>(async () => null) });
    renderAbout(about);
    await screen.findByText("Markiro Автоном");
    await waitFor(() => expect(about.hello).toHaveBeenCalledWith("https://127.0.0.1:45710"));
    const paired = fakeAbout({
      pairing: vi.fn<AboutApi["pairing"]>(async () => ({
        ...DEVICE_STATUS,
        hostAddress: "https://192.168.0.7:45710",
      })),
    });
    renderAbout(paired);
    await waitFor(() => expect(paired.hello).toHaveBeenCalledWith("https://192.168.0.7:45710"));
  });

  it("keeps the license a placeholder: no license logic, only the empty state", async () => {
    renderAbout(fakeAbout());
    const license = card("Лицензия");
    expect(within(license).getByText("Лицензирование ещё не подключено")).toBeTruthy();
    expect(within(license).queryAllByRole("button")).toHaveLength(0);
    expect(within(license).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows exactly the two support addresses and nothing else, and opens mail through the shell", async () => {
    const about = fakeAbout();
    renderAbout(about);
    const contacts = card("Контакты и поддержка");
    expect(described(contacts, "Почта поддержки")).toBe("hello@v-b.tech");
    expect(described(contacts, "Запасной адрес")).toBe("vladislav.bogatyrev@gmail.com");
    // Nothing else is rendered: two rows, two buttons, no links, no vendor, requisites, phone, hours or site.
    expect(contacts.querySelectorAll("dt")).toHaveLength(2);
    expect(within(contacts).getAllByRole("button")).toHaveLength(2);
    expect(within(contacts).queryAllByRole("link")).toHaveLength(0);
    expect(contacts.textContent).not.toMatch(
      /ИП |ИНН|ОГРНИП|телефон|режим работы|часы работы|\+7|markiro\.app|сайт/i,
    );
    fireEvent.click(within(contacts).getByRole("button", { name: "Написать на hello@v-b.tech" }));
    expect(about.openLink).toHaveBeenLastCalledWith("mailto:hello@v-b.tech");
    fireEvent.click(
      within(contacts).getByRole("button", {
        name: "Написать на vladislav.bogatyrev@gmail.com",
      }),
    );
    expect(about.openLink).toHaveBeenLastCalledWith("mailto:vladislav.bogatyrev@gmail.com");
  });

  it("tells the person to write by hand to either address when the shell cannot open a link", async () => {
    const about = fakeAbout({
      openLink: vi.fn<AboutApi["openLink"]>(async () => {
        throw new ExternalLinkError("launch", "x");
      }),
    });
    renderAbout(about);
    fireEvent.click(screen.getByRole("button", { name: "Написать на hello@v-b.tech" }));
    expect(
      await screen.findByText(
        "Не удалось открыть почтовую программу. Напишите вручную на hello@v-b.tech или на vladislav.bogatyrev@gmail.com.",
      ),
    ).toBeTruthy();
  });

  it("builds the support text from the allowlist, copies it and shows it", async () => {
    const about = fakeAbout();
    const { session } = renderAbout(about);
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать и скопировать" }));
    await screen.findByText("Сведения скопированы в буфер обмена.");
    const text = writeText.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("Версия приложения: 0.1.0");
    expect(text).toContain("Версия хоста: 0.1.0");
    expect(text).toContain("Роль компьютера: Хост и станция");
    expect(text).toContain("Хост отвечает: да");
    expect(text).toContain("Связь с хостом: на связи");
    expect(text).toContain("Хост: https://127.0.0.1:45710 (id 3f1c2d4e)");
    expect(text).toContain("Последняя копия (UTC): 2026-10-09T14:00:00.000Z");
    expect(text).toContain("Лицензия: Лицензирование ещё не подключено");
    expect(text).not.toContain(HOST_ID);
    expect(text).not.toContain(DEVICE_STATUS.fingerprint);
    expect(session.api.getBackups).toHaveBeenCalled();
    const shown = screen.getByRole("textbox", { name: "Сведения для поддержки" });
    // A text field keeps line breaks as LF; the copy and the file keep the CRLF of the text.
    expect((shown as HTMLTextAreaElement).value).toBe(text.replaceAll("\r\n", "\n"));
    expect(about.openLink).not.toHaveBeenCalled();
  });

  it("keeps the text on screen to copy by hand when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderAbout(fakeAbout());
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать и скопировать" }));
    await screen.findByText(/Не удалось скопировать в буфер обмена/);
    expect(screen.getByRole("textbox", { name: "Сведения для поддержки" })).toBeTruthy();
  });

  it("saves the text into a file through the office's files and shows the folder", async () => {
    const files = fakeOfficeFiles();
    renderAbout(fakeAbout(), files);
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать и скопировать" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сохранить в файл" }));
    await screen.findByText(/Файл сохранён: /);
    expect(files.save).toHaveBeenCalledTimes(1);
    const [segments, saved] = files.save.mock.calls[0]!;
    expect(segments).toEqual(["Выгрузки", "Сведения для поддержки"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^markiro-support-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/);
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(saved[0]!.bytes);
    expect(body.startsWith("﻿Markiro Автоном — сведения для поддержки")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Показать папку" }));
    expect(files.open).toHaveBeenCalledWith(["Выгрузки", "Сведения для поддержки"]);
  });

  it("says when the file could not be saved", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new Error("disk full"));
    renderAbout(fakeAbout(), files);
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать и скопировать" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сохранить в файл" }));
    await screen.findByText(/Не удалось сохранить файл/);
  });

  it("opens a letter with no body for «Написать в поддержку»: the text is never in the link", async () => {
    const about = fakeAbout();
    renderAbout(about);
    fireEvent.click(await screen.findByRole("button", { name: "Сформировать и скопировать" }));
    await screen.findByText("Сведения скопированы в буфер обмена.");
    fireEvent.click(screen.getByRole("button", { name: "Написать в поддержку" }));
    expect(about.openLink).toHaveBeenCalledWith("mailto:hello@v-b.tech");
  });

  it("has a table of contents of links to the sections' anchors, in the order of the registry", async () => {
    renderAbout(fakeAbout());
    const toc = await screen.findByRole("navigation", { name: "Разделы страницы" });
    const links = within(toc).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "О программе",
      "Лицензия",
      "Контакты и поддержка",
      "Сведения для поддержки",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#program",
      "#license",
      "#contacts",
      "#support",
    ]);
    for (const id of ["program", "license", "contacts", "support"]) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(ABOUT_SECTIONS.map((section) => section.id)).toEqual([
      "program",
      "license",
      "contacts",
      "support",
    ]);
  });

  it("is a page of the office's «Сервис» for both roles, and works without the shell", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const session = fakeOfficeSession(user === undefined ? {} : { user });
      const { unmount } = renderOffice(session);
      const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
      const item = within(nav).getByRole("link", { name: "Информация" });
      fireEvent.click(item);
      await screen.findByRole("heading", { name: "Информация", level: 1 });
      // No Tauri here: every part falls back to «неизвестно» and the page still stands.
      await screen.findByText("хост не отвечает");
      expect(screen.getByRole("heading", { name: "Контакты и поддержка", level: 2 })).toBeTruthy();
      unmount();
    }
  });
});
