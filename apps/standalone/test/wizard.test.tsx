import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { DeviceError } from "../src/host/device.js";
import { BootstrapWizard } from "../src/wizard/BootstrapWizard.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("BootstrapWizard", () => {
  it("creates the site from every answer", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(EXPECTED_REQUEST));
  });

  it("stays on a step until its fields are right", async () => {
    render(<BootstrapWizard onSubmit={vi.fn()} />);
    type("Логин", "admin");
    type("Имя и фамилия", "Ирина");
    type("Пароль", "correct horse battery");
    type("Повторите пароль", "another password");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(screen.getByText("Шаг 1 из 5 · Администратор")).toBeTruthy();
  });

  it("checks the GLN check digit before leaving the organization step", async () => {
    render(<BootstrapWizard onSubmit={vi.fn()} />);
    type("Имя и фамилия", "Ирина");
    type("Пароль", "correct horse battery");
    type("Повторите пароль", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Шаг 2 из 5 · Организация");
    type("Название организации", "ООО «Атолл»");
    type("GLN организации", "4600682000010");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Неверная контрольная цифра GLN")).toBeTruthy();
  });

  it("returns to the field the host rejected", async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "the GLN must be 13 digits",
        details: { field: "org.gln" },
      }),
    );
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    expect(await screen.findByText("Хост не принял это значение. Проверьте его.")).toBeTruthy();
    expect(screen.getByText("Шаг 2 из 5 · Организация")).toBeTruthy();
    expect(screen.getByLabelText("GLN организации")).toBeTruthy();
  });

  it("shows any other failure above the form", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new DeviceError("unreachable", "down"));
    render(<BootstrapWizard onSubmit={onSubmit} />);
    await completeWizard();
    expect(await screen.findByText("Служба хоста на этом компьютере не отвечает.")).toBeTruthy();
    expect(screen.getByText("Шаг 5 из 5 · Проверка")).toBeTruthy();
  });
});
