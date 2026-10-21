import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";
import { ACCOUNTANT_ME, renderSaasApp, SUPPORT_ME } from "./render.js";
import {
  BETA_VIEW,
  type FakeXhr,
  installerFile,
  installFakeXhr,
  installStandaloneReleasesApi,
  manifestFile,
  manifestJws,
  RELEASE_LIST,
  release,
  STABLE_VIEW,
} from "./standalone-releases-fixtures.js";

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

const PAGE = "/standalone-releases";
const BASE = "/api/platform/standalone-releases";

async function openPage() {
  renderSaasApp({ initialEntry: PAGE });
  expect(await screen.findByRole("heading", { level: 1, name: "Выпуски автонома" })).toBeDefined();
}

function channelSection(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function rowOf(section: HTMLElement, version: string): HTMLElement {
  const row = within(section)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(version, { exact: true }) !== null);
  if (!row) throw new Error(`No row for ${version}`);
  return row;
}

async function chooseFiles(user: ReturnType<typeof userEvent.setup>, files: File[]) {
  await user.upload(screen.getByTestId("file-drop-input"), files);
}

describe("standalone releases rail entry", () => {
  it("is shown to the platform admin", async () => {
    installStandaloneReleasesApi();
    await openPage();
    const link = screen.getByRole("link", { name: "Выпуски автонома" });
    expect(link.getAttribute("href")).toBe(PAGE);
  });

  it.each([
    ["support", SUPPORT_ME],
    ["accountant", ACCOUNTANT_ME],
  ])("is hidden from %s, and the page neither lists nor offers uploads", async (_role, me) => {
    const api = installStandaloneReleasesApi({ me });
    renderSaasApp({ initialEntry: PAGE });

    await screen.findByRole("navigation", { name: "Разделы платформы" });
    expect(
      await screen.findByText("Раздел доступен только администратору платформы."),
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: "Выпуски автонома" })).toBeNull();
    expect(screen.queryByTestId("file-drop-input")).toBeNull();
    expect(api.calls.some((call) => call.url.startsWith(BASE))).toBe(false);
  });
});

describe("standalone releases list", () => {
  it("explains an unconfigured bucket and offers no upload", async () => {
    installStandaloneReleasesApi({ list: { configured: false } });
    await openPage();

    expect(await screen.findByText("Хранилище выпусков не настроено")).toBeDefined();
    expect(screen.getByText(/RELEASES_S3_\*/)).toBeDefined();
    expect(screen.queryByTestId("file-drop-input")).toBeNull();
    expect(screen.queryByRole("region", { name: "Стабильный канал" })).toBeNull();
  });

  it("shows each channel's latest version, releases and the action that fits each", async () => {
    installStandaloneReleasesApi();
    await openPage();

    const stable = await screen.findByRole("region", { name: "Стабильный канал" });
    expect(within(stable).getByText("Последняя: 0.4.0")).toBeDefined();

    const current = rowOf(stable, "0.4.0");
    expect(within(current).getByText("Последняя")).toBeDefined();
    expect(
      within(current).queryByRole("button", { name: /Сделать последней|Откатить/ }),
    ).toBeNull();
    expect(within(rowOf(stable, "0.5.0")).getByRole("button", { name: "Сделать последней" }));
    expect(within(rowOf(stable, "0.3.0")).getByRole("button", { name: "Откатить на эту версию" }));

    const newer = rowOf(stable, "0.5.0");
    expect(within(newer).getByText("60,0 МБ")).toBeDefined();
    expect(within(newer).getByText("release-2026-1")).toBeDefined();
    expect(within(newer).getByText("Изменения 0.5.0")).toBeDefined();
    expect(within(newer).getByTitle("ab".repeat(32))).toBeDefined();
    expect(
      within(newer)
        .getByRole("link", { name: /Установщик/ })
        .getAttribute("href"),
    ).toBe(release("stable", "0.5.0").installer.url);
    expect(
      within(newer)
        .getByRole("link", { name: /Манифест/ })
        .getAttribute("href"),
    ).toBe(release("stable", "0.5.0").manifest.url);

    const beta = channelSection("Бета-канал");
    expect(within(beta).getByText("Последняя версия не опубликована")).toBeDefined();
    expect(within(beta).getByText("Версий ещё нет")).toBeDefined();
  });

  it("offers promotion for every release when the channel has no latest", async () => {
    installStandaloneReleasesApi({
      list: {
        ...RELEASE_LIST,
        channels: [BETA_VIEW, { ...STABLE_VIEW, latest: null, latestReadable: false, pending: [] }],
      },
    });
    await openPage();
    const stable = await screen.findByRole("region", { name: "Стабильный канал" });

    expect(within(stable).getByText(/latest\.json канала не читается/)).toBeDefined();
    for (const version of ["0.5.0", "0.4.0", "0.3.0"]) {
      expect(
        within(rowOf(stable, version)).getByRole("button", { name: "Сделать последней" }),
      ).toBeDefined();
    }
  });
});

describe("standalone releases pointer", () => {
  it("promotes a newer version after confirmation", async () => {
    const api = installStandaloneReleasesApi();
    const user = userEvent.setup();
    await openPage();
    const stable = await screen.findByRole("region", { name: "Стабильный канал" });

    await user.click(
      within(rowOf(stable, "0.5.0")).getByRole("button", { name: "Сделать последней" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Сайт начнёт раздавать версию 0\.5\.0/)).toBeDefined();
    expect(api.writes()).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Сделать последней" }));
    await waitFor(() =>
      expect(api.writes()).toEqual([
        { url: `${BASE}/stable/latest`, method: "PUT", body: { version: "0.5.0" } },
      ]),
    );
    expect(await screen.findByText("Последняя версия канала «Стабильный» — 0.5.0.")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("rolls back to an older version after confirmation", async () => {
    const api = installStandaloneReleasesApi();
    const user = userEvent.setup();
    await openPage();
    const stable = await screen.findByRole("region", { name: "Стабильный канал" });

    await user.click(
      within(rowOf(stable, "0.3.0")).getByRole("button", { name: "Откатить на эту версию" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/версию 0\.3\.0 вместо 0\.4\.0/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Откатить" }));

    await waitFor(() =>
      expect(api.writes()).toEqual([
        { url: `${BASE}/stable/latest`, method: "PUT", body: { version: "0.3.0" } },
      ]),
    );
  });

  it("keeps the dialog open with the integrity refusal", async () => {
    installStandaloneReleasesApi({ latestStatus: 409 });
    const user = userEvent.setup();
    await openPage();
    const stable = await screen.findByRole("region", { name: "Стабильный канал" });

    await user.click(
      within(rowOf(stable, "0.5.0")).getByRole("button", { name: "Сделать последней" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Сделать последней" }));

    expect(
      await within(dialog).findByText(
        "Файлы версии изменились после регистрации или ключ отозван — указатель не перенесён.",
      ),
    ).toBeDefined();
  });
});

describe("standalone releases pending versions", () => {
  it("verifies and registers an unfinished upload", async () => {
    const api = installStandaloneReleasesApi();
    const user = userEvent.setup();
    await openPage();
    const stable = await screen.findByRole("region", { name: "Стабильный канал" });

    await user.click(within(stable).getByRole("button", { name: "Проверить и зарегистрировать" }));
    await waitFor(() =>
      expect(api.writes()).toEqual([
        {
          url: `${BASE}/registrations`,
          method: "POST",
          body: { channel: "stable", version: "0.6.0" },
        },
      ]),
    );
    expect(await screen.findByText(/Версия 0\.6\.0 зарегистрирована/)).toBeDefined();
    await waitFor(() => expect(api.lists().length).toBeGreaterThanOrEqual(2));
  });
});

describe("standalone release upload", () => {
  it("previews the manifest, uploads both files with progress and registers the version", async () => {
    const api = installStandaloneReleasesApi();
    const xhr = installFakeXhr("manual");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    const preview = await screen.findByRole("group", { name: "Выбранный выпуск" });
    expect(within(preview).getByText("Стабильный")).toBeDefined();
    expect(within(preview).getByText("0.7.0")).toBeDefined();
    expect(within(preview).getByText("ab".repeat(32))).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Загрузить и проверить" }));
    await waitFor(() =>
      expect(api.writes()[0]).toEqual({
        url: `${BASE}/uploads`,
        method: "POST",
        body: { channel: "stable", version: "0.7.0" },
      }),
    );

    await waitFor(() => expect(xhr.instances).toHaveLength(1));
    const manifestPut = xhr.instances[0] as FakeXhr;
    expect(manifestPut.method).toBe("PUT");
    expect(manifestPut.url).toContain("markiro-standalone-0.7.0.update.jws?X-Amz-Signature=m");
    expect(manifestPut.headers).toEqual({ "Content-Type": "application/octet-stream" });
    expect(manifestPut.withCredentials).toBe(false);
    expect((manifestPut.body as File).name).toBe("markiro-standalone-0.7.0.update.jws");
    act(() => manifestPut.respond(200));

    await waitFor(() => expect(xhr.instances).toHaveLength(2));
    const installerPut = xhr.instances[1] as FakeXhr;
    expect(installerPut.url).toContain(
      "markiro-standalone-0.7.0-windows-x86_64-setup.exe?X-Amz-Signature=i",
    );
    expect(installerPut.headers).toEqual({ "Content-Type": "application/octet-stream" });
    expect((installerPut.body as File).name).toBe(
      "markiro-standalone-0.7.0-windows-x86_64-setup.exe",
    );
    act(() => installerPut.progress(50, 200));
    const bar = screen.getByRole("progressbar", { name: "Установщик" });
    expect(bar.getAttribute("value")).toBe("25");
    expect(screen.getByText("25 %")).toBeDefined();
    expect(api.writes()).toHaveLength(1);

    act(() => installerPut.respond(200));
    expect(
      await screen.findByText(/Версия 0\.7\.0 зарегистрирована в канале «Стабильный»/),
    ).toBeDefined();
    expect(api.writes()[1]).toEqual({
      url: `${BASE}/registrations`,
      method: "POST",
      body: { channel: "stable", version: "0.7.0" },
    });
    await waitFor(() => expect(api.lists().length).toBeGreaterThanOrEqual(2));
  });

  it("reports an already registered identical version", async () => {
    installStandaloneReleasesApi({ registerOutcome: "unchanged" });
    installFakeXhr("auto");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));
    expect(
      await screen.findByText("Версия 0.7.0 уже зарегистрирована с теми же файлами."),
    ).toBeDefined();
  });

  it("explains a bucket that refuses the request (CORS or network) and does not register", async () => {
    const api = installStandaloneReleasesApi();
    installFakeXhr("error");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));

    expect(
      await screen.findByText(/Хранилище не приняло файл\. Проверьте CORS бакета релизов/),
    ).toBeDefined();
    expect(api.writes().map((call) => call.url)).toEqual([`${BASE}/uploads`]);
  });

  it("explains a bucket that answers with an error status", async () => {
    installStandaloneReleasesApi();
    installFakeXhr("reject");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));
    expect(await screen.findByText(/Хранилище отклонило файл \(HTTP 403\)/)).toBeDefined();
  });

  it("cancels an upload in flight", async () => {
    const api = installStandaloneReleasesApi();
    const xhr = installFakeXhr("manual");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));
    await waitFor(() => expect(xhr.instances).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Отменить загрузку" }));

    expect(xhr.instances[0]?.aborted).toBe(true);
    expect(await screen.findByText(/Загрузка отменена/)).toBeDefined();
    expect(api.writes().map((call) => call.url)).toEqual([`${BASE}/uploads`]);
  });

  it.each([
    [
      "standalone_release_manifest_bad_signature",
      "Подпись манифеста не сходится: файл изменён после подписи или подписан другим ключом.",
    ],
    [
      "standalone_release_manifest_unknown_key",
      "Манифест подписан ключом, которого нет у автономов. Подпишите пакет действующим ключом выпусков.",
    ],
    [
      "standalone_release_installer_hash_mismatch",
      "SHA-256 установщика не совпадает с манифестом.",
    ],
    ["standalone_release_installer_size_mismatch", "Размер установщика не совпадает с манифестом."],
    [
      "standalone_release_manifest_mismatch",
      "Манифест описывает другой продукт, канал, версию или установщик, чем загруженные файлы.",
    ],
    [
      "standalone_release_manifest_malformed",
      "Манифест повреждён или это не манифест обновления автонома.",
    ],
    [
      "standalone_release_files_missing",
      "В хранилище нет одного из файлов версии. Загрузите оба файла заново.",
    ],
    ["standalone_release_installer_too_large", "Установщик больше допустимого размера."],
  ])("explains the registration refusal %s", async (code, message) => {
    installStandaloneReleasesApi({ registerStatus: 422, registerError: code });
    installFakeXhr("auto");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));
    expect(await screen.findByText(message)).toBeDefined();
    expect(screen.getByText(/Файлы этой попытки удалены из хранилища/)).toBeDefined();
  });

  it.each([
    [
      409,
      "standalone_release_version_not_newer",
      "Версия должна быть выше всех уже опубликованных в канале.",
    ],
    [
      409,
      "standalone_release_immutable",
      "Эта версия уже опубликована с другими файлами — пути неизменяемы.",
    ],
  ])("explains the conflict %s %s", async (status, code, message) => {
    installStandaloneReleasesApi({ registerStatus: status, registerError: code });
    installFakeXhr("auto");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile()]);
    await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));
    expect(await screen.findByText(message)).toBeDefined();
  });

  it.each([
    [409, "standalone_release_version_exists", /Версия 0\.7\.0 уже загружена в этот канал/],
    [
      409,
      "standalone_release_version_not_newer",
      /Версия должна быть выше всех уже опубликованных/,
    ],
    [503, "standalone_releases_not_configured", /Хранилище выпусков не настроено/],
    [503, "standalone_releases_storage_unavailable", /Хранилище выпусков сейчас недоступно/],
  ])(
    "explains an upload refusal %s %s before touching the bucket",
    async (status, code, message) => {
      installStandaloneReleasesApi({ uploadStatus: status, uploadError: code });
      const xhr = installFakeXhr("auto");
      const user = userEvent.setup();
      await openPage();
      await screen.findByRole("region", { name: "Стабильный канал" });

      await chooseFiles(user, [manifestFile(), installerFile()]);
      await user.click(await screen.findByRole("button", { name: "Загрузить и проверить" }));
      expect(await screen.findByText(message)).toBeDefined();
      expect(xhr.instances).toHaveLength(0);
    },
  );

  it("blocks an installer whose size differs from the manifest", async () => {
    const api = installStandaloneReleasesApi();
    installFakeXhr("auto");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile(), installerFile("0.7.0", "short")]);
    expect(await screen.findByText(/Размер выбранного установщика/)).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Загрузить и проверить" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.writes()).toHaveLength(0);
  });

  it("rejects a file that is not a JWS manifest", async () => {
    installStandaloneReleasesApi();
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [manifestFile("not a manifest"), installerFile()]);
    expect(
      await screen.findByText(
        "Это не манифест обновления: ожидается одна строка JWS из трёх частей.",
      ),
    ).toBeDefined();
  });

  it("takes the channel from the manifest", async () => {
    const api = installStandaloneReleasesApi();
    installFakeXhr("auto");
    const user = userEvent.setup();
    await openPage();
    await screen.findByRole("region", { name: "Стабильный канал" });

    await chooseFiles(user, [
      manifestFile(manifestJws({ channel: "beta", version: "0.8.0" }), "0.8.0"),
      installerFile("0.8.0"),
    ]);
    const preview = await screen.findByRole("group", { name: "Выбранный выпуск" });
    expect(within(preview).getByText("Бета")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Загрузить и проверить" }));
    await waitFor(() =>
      expect(api.writes()[0]?.body).toEqual({ channel: "beta", version: "0.8.0" }),
    );
  });
});
