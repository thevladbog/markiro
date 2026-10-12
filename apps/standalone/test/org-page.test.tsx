import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens the profile from the menu, as a user does. */
async function openProfile(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
  await screen.findByRole("heading", { name: "Профиль организации" });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getOrgLogo.mockResolvedValue({ logo: null });
  return session;
}

describe("organization profile", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows a technologist the profile without a form", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    session.api.getOrgLogo.mockResolvedValue({ logo: null });
    await openProfile(session);
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(screen.getByText("4600682000013")).toBeTruthy();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(session.api.getOrg).toHaveBeenCalledWith("office-session-token");
  });

  it("saves an administrator's change with the loaded revision", async () => {
    const session = adminSession();
    session.api.updateOrg.mockResolvedValue({ ...ORG_PROFILE, name: "ООО «Атолл-Юг»", rev: 5 });
    await openProfile(session);
    const name = await screen.findByLabelText("Название организации");
    expect(name).toHaveProperty("value", "ООО «Атолл»");
    expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", true);
    fireEvent.change(name, { target: { value: " ООО «Атолл-Юг» " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateOrg).toHaveBeenCalledWith("office-session-token", {
      name: "ООО «Атолл-Юг»",
      inn: "7701234567",
      gln: "4600682000013",
      gs1Prefixes: ["4600682"],
      timeZone: "Europe/Moscow",
      expectedRev: 4,
    });
    expect(screen.getByLabelText("Название организации")).toHaveProperty("value", "ООО «Атолл-Юг»");
    // The saved profile replaced the cached one; nothing was read again.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("clears the success notice when the next save starts", async () => {
    const session = adminSession();
    session.api.updateOrg
      .mockResolvedValueOnce({ ...ORG_PROFILE, name: "ООО «Атолл-Юг»", rev: 5 })
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          status: 400,
          message: "the GLN must be 13 digits",
          details: { field: "gln" },
        }),
      );
    await openProfile(session);
    const name = await screen.findByLabelText("Название организации");
    fireEvent.change(name, { target: { value: "ООО «Атолл-Юг»" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Название организации"), {
      target: { value: "ООО «Атолл-Запад»" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
  });

  it("checks the GLN's check digit before calling the host", async () => {
    const session = adminSession();
    await openProfile(session);
    await screen.findByLabelText("GLN организации");
    type("GLN организации", "4600682000010");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Неверная контрольная цифра GLN")).toBeTruthy();
    expect(session.api.updateOrg).not.toHaveBeenCalled();
  });

  it("warns that a GLN with another prefix starts other SSCC counters", async () => {
    await openProfile(adminSession());
    await screen.findByLabelText("GLN организации");
    expect(screen.queryByText(/Префикс SSCC станет/)).toBeNull();
    type("GLN организации", "4607091000016");
    expect(await screen.findByText(/Префикс SSCC станет 460709100\./)).toBeTruthy();
  });

  it("puts the host's refusal under the field it names", async () => {
    const session = adminSession();
    session.api.updateOrg.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "an IANA time zone name is required",
        details: { field: "timeZone" },
      }),
    );
    await openProfile(session);
    await screen.findByLabelText("Название организации");
    type("Название организации", "ООО «Атолл-Юг»");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Хост не принял это значение. Проверьте его.")).toBeTruthy();
  });

  it("offers to load the profile again after a stale save", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg
      .mockResolvedValueOnce(ORG_PROFILE)
      .mockResolvedValueOnce({ ...ORG_PROFILE, name: "ООО «Атолл-Север»", rev: 6 });
    session.api.updateOrg.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 6 },
      }),
    );
    await openProfile(session);
    await screen.findByLabelText("Название организации");
    type("Название организации", "ООО «Атолл-Юг»");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Название организации")).toHaveProperty(
        "value",
        "ООО «Атолл-Север»",
      ),
    );
    expect(session.api.getOrg).toHaveBeenCalledTimes(2);
    expect(session.api.updateOrg).toHaveBeenCalledTimes(1);
  });

  it("explains a failed load and retries it", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockResolvedValueOnce(ORG_PROFILE);
    session.api.getOrgLogo.mockResolvedValue({ logo: null });
    await openProfile(session);
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название организации")).toBeTruthy();
  });
});
