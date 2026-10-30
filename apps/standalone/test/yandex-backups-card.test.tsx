import { fireEvent, screen, waitFor, render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { YandexResume } from "../src/wizard/YandexResume.js";
import { YandexRestoreWizard } from "../src/wizard/YandexRestoreWizard.js";
import { yandexNative } from "../src/host/yandex-native.js";
import { renderOffice, fakeOfficeSession, TECHNOLOGIST } from "./support/office.js";
import { HEALTHY_BACKUPS } from "./support/backups.js";
import { openSelectOn } from "./support/select.js";
vi.mock("../src/host/yandex-native.js", () => ({
  yandexNative: {
    auth: vi.fn(),
    list: vi.fn(),
    download: vi.fn(),
    restore: vi.fn(),
    resume: vi.fn(),
    recoveryAvailable: vi.fn(),
    cancel: vi.fn(),
    connect: vi.fn(),
    registration: vi.fn(),
    importProfile: vi.fn(),
    exportProfile: vi.fn(),
  },
}));
describe("Yandex connection and recovery", () => {
  it("hides recovery resume after a completed job or an ordinary service outage", async () => {
    vi.mocked(yandexNative.recoveryAvailable).mockResolvedValue(false);
    render(<YandexResume />);
    await waitFor(() => expect(yandexNative.recoveryAvailable).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Продолжить прерванное восстановление/ }),
    ).toBeNull();
    expect(yandexNative.resume).not.toHaveBeenCalled();
  });
  it("offers resume only when native code finds an unfinished recovery job", async () => {
    vi.mocked(yandexNative.recoveryAvailable).mockResolvedValue(true);
    render(<YandexResume />);
    expect(
      await screen.findByRole("button", { name: /Продолжить прерванное восстановление/ }),
    ).toBeTruthy();
  });
  it("requires admin consent and passes only ClientID and Office session to the native bridge", async () => {
    const session = fakeOfficeSession();
    session.api.getBackups.mockResolvedValue(HEALTHY_BACKUPS);
    renderOffice(session, { initialPath: "/backups" });
    const connect = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Подключить / заменить ClientSecret",
    });
    fireEvent.change(screen.getByLabelText("ClientID"), { target: { value: "customer-client" } });
    expect(connect.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /ключ хранится рядом с копией/ }));
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await waitFor(() =>
      expect(yandexNative.connect).toHaveBeenCalledWith("customer-client", expect.any(String)),
    );
  });
  it("reader can see cloud state but cannot start native authorization", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getBackups.mockResolvedValue(HEALTHY_BACKUPS);
    renderOffice(session, { initialPath: "/backups" });
    await screen.findByRole("heading", { name: "Яндекс Диск" });
    expect(screen.queryByRole("button", { name: "Подключить / заменить ClientSecret" })).toBeNull();
  });
  it("requires explicit snapshot selection and old-host confirmation before restoring", async () => {
    vi.mocked(yandexNative.auth).mockResolvedValue("account");
    vi.mocked(yandexNative.list).mockResolvedValue([
      {
        hostId: "11111111-1111-4111-8111-111111111111",
        snapshotId: "22222222-2222-4222-8222-222222222222",
        organizationLabel: "Factory",
        inn: "1234567890",
        appVersion: "1.1",
        createdAt: "2026-10-23T00:00:00Z",
        sizeBytes: 100,
      },
    ]);
    vi.mocked(yandexNative.download).mockResolvedValue(undefined);
    vi.mocked(yandexNative.restore).mockResolvedValue(undefined);
    render(<YandexRestoreWizard onBack={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("ClientID"), { target: { value: "customer-client" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти в Яндекс" }));
    const select = await screen.findByRole("combobox");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Скачать и проверить" }).disabled,
    ).toBe(true);
    openSelectOn(select);
    fireEvent.click(screen.getByRole("option", { name: /Factory/ }));
    expect(
      screen.getByText("Идентификатор хоста: 11111111-1111-4111-8111-111111111111"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Скачать и проверить" }));
    const apply = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Восстановить на этом ПК",
    });
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(apply);
    await waitFor(() => expect(yandexNative.restore).toHaveBeenCalledOnce());
  });
  it("allows authorization retry when the authorized account's copy list fails", async () => {
    vi.mocked(yandexNative.auth).mockResolvedValue("account");
    vi.mocked(yandexNative.list).mockRejectedValueOnce("network");
    render(<YandexRestoreWizard onBack={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("ClientID"), { target: { value: "customer-client" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти в Яндекс" }));
    await screen.findByRole("alert");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Войти в Яндекс" }).disabled).toBe(
      false,
    );
    expect(screen.getByLabelText<HTMLInputElement>("ClientID").disabled).toBe(false);
  });
});
