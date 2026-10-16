import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EntityDrawer } from "../src/office/EntityDrawer.js";
import { FormDialog } from "../src/office/FormDialog.js";

describe("the L2 form dialog: the summary of field errors", () => {
  function dialog(errorCount?: number) {
    render(
      <FormDialog
        title="Новый оператор"
        submitLabel="Добавить"
        onSubmit={async () => undefined}
        onClose={() => undefined}
        {...(errorCount === undefined ? {} : { errorCount })}
      >
        <p>Поля</p>
      </FormDialog>,
    );
  }

  it("says how many fields to fix, as an alert, above the fields", () => {
    dialog(2);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Исправьте поля с ошибками: 2.");
    const form = screen.getByRole("dialog").querySelector("form");
    expect(form?.firstElementChild).toBe(alert);
  });

  it("says nothing when no field is wrong", () => {
    dialog(0);
    expect(screen.queryByRole("alert")).toBeNull();
    cleanupDialog();
    dialog();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function cleanupDialog() {
  document.body.innerHTML = "";
}

describe("the L2 side drawer: the unsaved mark and the guard", () => {
  function drawer(dirty: boolean, onClose = vi.fn()) {
    render(
      <EntityDrawer
        title="Товар «Квас»"
        submitLabel="Сохранить"
        dirty={dirty}
        onSubmit={async () => undefined}
        onClose={onClose}
      >
        <p>Поля</p>
      </EntityDrawer>,
    );
    return onClose;
  }

  it("marks unsaved changes in the footer with a word, not only a colour", () => {
    drawer(true);
    const footer = screen.getByRole("dialog").querySelector(".mk-side-panel__footer");
    expect(footer?.textContent).toContain("Есть несохранённые изменения");
  });

  it("shows no mark while the form is as it was loaded", () => {
    drawer(false);
    expect(screen.queryByText("Есть несохранённые изменения")).toBeNull();
  });

  it("asks before closing a dirty form: «Вернуться к правке» keeps it, «Закрыть без сохранения» drops it", async () => {
    const onClose = drawer(true);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    const ask = screen.getByRole("alertdialog", { name: "Закрыть без сохранения?" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Вернуться к правке" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Закрыть без сохранения",
        }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a clean form at once", () => {
    const onClose = drawer(false);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the word that opens a field's error message", () => {
  it("is set on the document root by the office from i18n, and taken away with it", async () => {
    const { fakeOfficeSession, renderOffice } = await import("./support/office.js");
    const view = renderOffice(fakeOfficeSession());
    await screen.findByRole("link", { name: "Обзор" });
    expect(document.documentElement.style.getPropertyValue("--mk-error-prefix")).toBe(
      '"Ошибка · "',
    );
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--mk-error-prefix")).toBe("");
  });
});
