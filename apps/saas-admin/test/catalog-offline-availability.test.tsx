import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PLATFORM_ADMIN_ME,
  PUBLISHED_PLAN,
  SERVICE,
  installCatalogApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FLAG_LABEL = "Доступно офлайн-клиентам";

describe("offline availability in the catalog editor", () => {
  it("shows an Offline badge for a flagged item in the list, and none for an unflagged one", async () => {
    installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [
        { ...PUBLISHED_PLAN, offlineAvailable: true },
        {
          ...PUBLISHED_PLAN,
          id: "32111111-1111-4111-8111-111111111111",
          catalogItemCode: "plan-cloud",
          nameRu: "Облачный",
          offlineAvailable: false,
        },
      ],
    });
    renderSaasApp();
    const flagged = (await screen.findByRole("button", { name: /Базовый/ })).closest("tr");
    expect(within(flagged as HTMLElement).getByText("Офлайн")).toBeDefined();
    const cloud = screen.getByRole("button", { name: /Облачный/ }).closest("tr");
    expect(within(cloud as HTMLElement).queryByText("Офлайн")).toBeNull();
  });

  it("lets a platform admin flag a published plan with a reason", async () => {
    const api = installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: false }],
    });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Открыть Базовый/ }));
    await user.click(await screen.findByRole("checkbox", { name: FLAG_LABEL }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Подтвердить" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText("Основание"), "Поставка автонома");
    await user.click(confirm);
    await waitFor(() =>
      expect(api.offlineAvailabilityCalls()).toEqual([
        {
          code: PUBLISHED_PLAN.catalogItemCode,
          body: { offlineAvailable: true, reason: "Поставка автонома" },
        },
      ]),
    );
    expect((await screen.findByText("Позиция доступна офлайн-клиентам.")).textContent).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: FLAG_LABEL }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });

  it("warns about standing assignments before the withdrawal and reports the holders after it", async () => {
    const api = installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: true }],
      offlineAvailability: { status: 200, holders: 3 },
    });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Открыть Базовый/ }));
    await user.click(await screen.findByRole("checkbox", { name: FLAG_LABEL }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Уже сделанные назначения остаются в силе");
    await user.type(within(dialog).getByLabelText("Основание"), "Вывод из продажи");
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить" }));
    await waitFor(() =>
      expect(api.offlineAvailabilityCalls()).toEqual([
        {
          code: PUBLISHED_PLAN.catalogItemCode,
          body: { offlineAvailable: false, reason: "Вывод из продажи" },
        },
      ]),
    );
    expect(
      (await screen.findByText(/Снято\. Назначения остаются в силе у клиентов без кабинета: 3/))
        .textContent,
    ).toBeTruthy();
  });

  it("offers the switch for an add-on, and for neither a service nor a non-admin", async () => {
    installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [ADDON, SERVICE],
    });
    const { unmount } = renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(await screen.findByRole("button", { name: /Открыть/ }));
    expect(await screen.findByRole("checkbox", { name: FLAG_LABEL })).toBeDefined();
    unmount();
    cleanup();

    installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [SERVICE],
    });
    renderSaasApp();
    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(await screen.findByRole("button", { name: /Открыть/ }));
    await screen.findByRole("region", { name: /Версия/ });
    expect(screen.queryByRole("checkbox", { name: FLAG_LABEL })).toBeNull();
  });

  it("shows only the badge, no switch, to an accountant", async () => {
    installCatalogApi({
      me: ACCOUNTANT_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: true }],
    });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Открыть Базовый/ }));
    const panel = await screen.findByRole("region", { name: /Базовый/ });
    expect(screen.queryByRole("checkbox", { name: FLAG_LABEL })).toBeNull();
    expect(within(panel).getByText("Офлайн")).toBeDefined();
  });

  it("shows a refusal as text and keeps the switch where it was", async () => {
    installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [{ ...PUBLISHED_PLAN, offlineAvailable: false }],
      offlineAvailability: { status: 409, code: "catalog_offline_availability_forbidden" },
    });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Открыть Базовый/ }));
    await user.click(await screen.findByRole("checkbox", { name: FLAG_LABEL }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Основание"), "Причина");
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить" }));
    expect(
      (await screen.findByText("Менять доступность может только администратор платформы."))
        .textContent,
    ).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: FLAG_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});
