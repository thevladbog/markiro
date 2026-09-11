import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ENTITLEMENT_SNAPSHOT } from "./entitlements-fixture.js";
import { installTenantApi, jsonResponse, renderSaasApp, TENANT_ID } from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["pending", "uncertain", "401", "403", "429"])(
  "keeps the exact confirmation through tenant tab and route navigation while %s",
  async (phase) => {
    installTenantApi();
    const original = globalThis.fetch;
    const confirms: Record<string, unknown>[] = [];
    let previewCount = 0;
    let loseResponse = () => {};
    const lost = new Promise<Response>((_resolve, reject) => {
      loseResponse = () => reject(new TypeError("response lost"));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (String(input).endsWith("/preview")) {
          previewCount++;
          const body = JSON.parse(String(init.body)) as { command: { requestId: string } };
          return jsonResponse(200, {
            previewId: "31111111-1111-4111-8111-111111111111",
            requestId: body.command.requestId,
            intent: "prepare",
            revision: "3",
            usageRevision: "2",
            expiresAt: "2099-01-01T00:00:00.000Z",
            before: ENTITLEMENT_SNAPSHOT,
            after: ENTITLEMENT_SNAPSHOT,
          });
        }
        if (String(input).endsWith("/confirm")) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          confirms.push(body);
          if (confirms.length === 1) return lost;
          if (confirms.length === 2 && ["401", "403", "429"].includes(phase))
            return jsonResponse(Number(phase), { code: "retry_rejected" });
          return jsonResponse(200, {
            ...body,
            sourceId: "41111111-1111-4111-8111-111111111111",
            confirmedAt: "2026-09-11T10:00:00.000Z",
            after: ENTITLEMENT_SNAPSHOT,
          });
        }
        return original(input, init);
      }),
    );
    const { router } = renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Подготовить источник" }));
    fireEvent.change(screen.getByLabelText("Основание"), { target: { value: "Approved reason" } });
    fireEvent.change(screen.getByLabelText("Ссылка на решение"), { target: { value: "decision" } });
    await user.click(screen.getByLabelText("НК: поиск товара"));
    await user.click(screen.getByRole("button", { name: "Рассчитать изменения" }));
    await user.click(await screen.findByRole("button", { name: "Подтвердить подготовку" }));
    await waitFor(() => expect(confirms).toHaveLength(1));
    if (phase !== "pending") {
      loseResponse();
      await screen.findByRole("button", { name: "Повторить подтверждение" });
      if (["401", "403", "429"].includes(phase)) {
        await user.click(screen.getByRole("button", { name: "Повторить подтверждение" }));
        await waitFor(() => expect(confirms).toHaveLength(2));
        await screen.findByText(
          phase === "429"
            ? "Слишком много запросов. Результат предыдущего подтверждения пока неизвестен. Подождите и повторите то же подтверждение."
            : "Не удалось проверить подтверждение из-за ограничения доступа или сессии. Результат предыдущего запроса пока неизвестен. После восстановления доступа повторите то же подтверждение, не закрывая форму.",
        );
        expect(
          (screen.getByLabelText("Основание") as HTMLInputElement).closest("fieldset")?.disabled,
        ).toBe(true);
        expect(
          (screen.getByRole("button", { name: "Подготовить источник" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true);
        expect(
          (
            screen.getByRole("button", { name: "Рассчитать изменения" }) as HTMLButtonElement
          ).closest("fieldset")?.disabled,
        ).toBe(true);
        expect(
          (screen.getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).closest("fieldset")
            ?.disabled,
        ).toBe(true);
      }
    }
    await user.click(screen.getByRole("tab", { name: /Юридические данные/ }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.getByLabelText("Основание")).toBeDefined();
    await user.click(screen.getByRole("link", { name: "Тенанты" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/tenants/${TENANT_ID}`));
    expect(screen.getByLabelText("Основание")).toBeDefined();
    if (phase === "pending") loseResponse();
    await user.click(await screen.findByRole("button", { name: "Повторить подтверждение" }));
    await screen.findByText("Изменение подготовлено. Текущие права не изменены.");
    expect(confirms).toHaveLength(["401", "403", "429"].includes(phase) ? 3 : 2);
    for (const confirmation of confirms) expect(confirmation).toEqual(confirms[0]);
    expect(previewCount).toBe(1);
    await user.click(screen.getByRole("tab", { name: /Юридические данные/ }));
    await screen.findByText("Юридические данные тенанта");
    await user.click(screen.getByRole("link", { name: "Тенанты" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/tenants"));
  },
);
