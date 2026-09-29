import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { can, useCan } from "../src/office/access.js";
import { FormDialog, type FormDialogProps } from "../src/office/FormDialog.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { WriteFailureAlert } from "../src/office/page-state.js";
import { fakeOfficeSession, TECHNOLOGIST } from "./support/office.js";

function renderDialog(props: Partial<FormDialogProps> = {}) {
  const onSubmit = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(
    <FormDialog
      title="Новая линия"
      submitLabel="Добавить"
      onSubmit={onSubmit}
      onClose={onClose}
      {...props}
    >
      <p>Поля формы</p>
    </FormDialog>,
  );
  return { onSubmit, onClose };
}

describe("FormDialog", () => {
  it("shows the title, the fields and both buttons, and sends the form", async () => {
    const { onSubmit, onClose } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Новая линия" });
    expect(dialog.querySelector("form")?.textContent).toBe("Поля формы");
    // `onSubmit` settles at once: `act` lets the dialog's own state follow it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with Cancel, Escape and the ×", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("waits while the form is being sent: no second send, no way to close", async () => {
    let finish: () => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { onClose } = renderDialog({ onSubmit });
    const submit = screen.getByRole("button", { name: "Добавить" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      finish();
    });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps the submit button off when asked, and marks a destructive action", () => {
    renderDialog({ submitDisabled: true, submitVariant: "destructive" });
    const submit = screen.getByRole("button", { name: "Добавить" });
    expect(submit).toHaveProperty("disabled", true);
    expect(submit.className).toContain("mk-btn--destructive");
  });

  it("shows the alert above the fields", () => {
    renderDialog({ alert: <p>Хост не ответил</p> });
    const form = screen.getByRole("dialog").querySelector("form");
    expect(form?.firstElementChild?.textContent).toBe("Хост не ответил");
  });

  it("shows nothing while closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("WriteFailureAlert", () => {
  it("offers to load the data again after a stale write when the form can", () => {
    const onReload = vi.fn();
    render(<WriteFailureAlert failure={{ kind: "stale" }} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("explains a stale write without a reload button when the form cannot reload", () => {
    render(<WriteFailureAlert failure={{ kind: "stale" }} />);
    expect(
      screen.getByText("Данные изменились, пока вы их редактировали. Обновите их и повторите."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains any other failure by its text, and shows nothing without one", () => {
    const { rerender } = render(
      <WriteFailureAlert failure={{ kind: "alert", message: "errors.api.forbidden" }} />,
    );
    expect(screen.getByText("Недостаточно прав для этого действия.")).toBeTruthy();
    rerender(<WriteFailureAlert failure={null} />);
    expect(screen.queryByText("Недостаточно прав для этого действия.")).toBeNull();
  });
});

describe("office capabilities", () => {
  it("let administrators change reference data, and both roles the catalog (spec §4.8)", () => {
    expect(can("admin", "editReference")).toBe(true);
    expect(can("technologist", "editReference")).toBe(false);
    expect(can("admin", "editCatalog")).toBe(true);
    expect(can("technologist", "editCatalog")).toBe(true);
  });

  it("follow the signed-in user's role", () => {
    function Probe() {
      return <p>{useCan("editReference") ? "можно" : "нельзя"}</p>;
    }
    const { rerender } = render(
      <OfficeSessionProvider value={fakeOfficeSession()}>
        <Probe />
      </OfficeSessionProvider>,
    );
    expect(screen.getByText("можно")).toBeTruthy();
    rerender(
      <OfficeSessionProvider value={fakeOfficeSession({ user: TECHNOLOGIST })}>
        <Probe />
      </OfficeSessionProvider>,
    );
    expect(screen.getByText("нельзя")).toBeTruthy();
  });
});
