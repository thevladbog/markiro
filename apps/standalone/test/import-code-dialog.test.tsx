import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImportAnalysis } from "../src/office/templates/import-analysis.js";
import {
  ImportCodeDialog,
  type ImportCodeDialogProps,
} from "../src/office/templates/ImportCodeDialog.js";

/** 58×40 mm at 203 dpi, a text line and a `{{qty}}` field. */
const ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "box", id: "frame", xMm: 1, yMm: 1, widthMm: 56, heightMm: 38, thicknessMm: 0.5 },
  ],
};

function open(props: Partial<ImportCodeDialogProps> = {}) {
  const onReplace = vi.fn<(analysis: ImportAnalysis) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <ImportCodeDialog
      purpose="box"
      initialFormat="zpl"
      initialDpi={203}
      unsaved={false}
      onClose={onClose}
      onReplace={onReplace}
      {...props}
    />,
  );
  return {
    onReplace,
    onClose,
    dialog: screen.getByRole("dialog", { name: "Импорт кода этикетки" }),
  };
}

function paste(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the template import dialog", () => {
  it("opens on the layout's format and resolution, wide, with both buttons off until there is code", () => {
    const { dialog } = open({ initialFormat: "tspl", initialDpi: 300 });
    expect(screen.getByRole("combobox", { name: "Формат кода" })).toHaveProperty("value", "tspl");
    expect(screen.getByRole("combobox", { name: "Разрешение кода" })).toHaveProperty(
      "value",
      "300",
    );
    expect(screen.getByLabelText("Код TSPL (TSC)")).toHaveProperty("value", "");
    expect(button("Проверить код")).toHaveProperty("disabled", true);
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
    expect(dialog.style.width).toBe("1040px");
    expect(
      screen.queryByText("Несохранённый макет будет заменён, когда вы подтвердите импорт."),
    ).toBeNull();
  });

  it("checks ZPL, sums it up and replaces the layout with what it found", async () => {
    const { onReplace } = open();
    paste("Код ZPL", ZPL);
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Распознано элементов: 2 · размер 58,06 × 40,04 мм")).toBeTruthy();
    expect(button("Заменить макет")).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.click(button("Заменить макет"));
    });
    expect(onReplace).toHaveBeenCalledTimes(1);
    const analysis = onReplace.mock.calls[0]?.[0];
    expect(analysis?.result.spec.elements).toHaveLength(2);
    expect(analysis?.result.spec.language).toBe("zpl");
  });

  it("drops the check when the code, the format or the resolution changes", () => {
    open();
    paste("Код ZPL", ZPL);
    fireEvent.click(button("Проверить код"));
    expect(button("Заменить макет")).toHaveProperty("disabled", false);
    paste("Код ZPL", `${ZPL}\n`);
    expect(screen.queryByText(/Распознано элементов/)).toBeNull();
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    fireEvent.click(button("Проверить код"));
    fireEvent.change(screen.getByRole("combobox", { name: "Разрешение кода" }), {
      target: { value: "300" },
    });
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Распознано элементов: 2 · размер 39,29 × 27,09 мм")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "tspl" },
    });
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
  });

  it("lists the lines it drops and replaces only once they are acknowledged", () => {
    open();
    paste("Код ZPL", ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ"));
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Неподдерживаемые строки: 1")).toBeTruthy();
    const warning = screen.getByText("^GFA,10,10,1,FF");
    expect(warning.closest("li")?.textContent).toBe("Строка 6: ^GFA,10,10,1,FF");
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Импортировать без неподдерживаемых строк (1)" }),
    );
    expect(button("Заменить макет")).toHaveProperty("disabled", false);
  });

  it("takes JSON without a resolution, passes a wrapper's name and warns about another purpose", async () => {
    const { onReplace } = open();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    expect(screen.queryByRole("combobox", { name: "Разрешение кода" })).toBeNull();
    paste(
      "JSON шаблона",
      JSON.stringify({ name: "Паллета <b>1</b>", purpose: "pallet", spec: JSON_SPEC }),
    );
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Предупреждения: 1")).toBeTruthy();
    expect(screen.getByText('purpose: "pallet"').closest("li")?.textContent).toBe(
      'purpose: "pallet" — не совпадает с назначением шаблона, макет импортируется как есть',
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Продолжить с этими предупреждениями (1)" }),
    );
    await act(async () => {
      fireEvent.click(button("Заменить макет"));
    });
    expect(onReplace.mock.calls[0]?.[0].name).toBe("Паллета <b>1</b>");
  });

  it("says why code cannot replace the layout: the parser's message, the schema's issues, a too large element", () => {
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    paste("JSON шаблона", "{");
    fireEvent.click(button("Проверить код"));
    expect(screen.getByRole("alert").textContent).toMatch(/^.Код не разобран: invalid JSON: /);
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    paste("JSON шаблона", JSON.stringify({ ...JSON_SPEC, elements: [{ kind: "text", id: "a" }] }));
    fireEvent.click(button("Проверить код"));
    const issues = screen.getByRole("alert");
    expect(within(issues).getByText(/^Ошибок в коде: /)).toBeTruthy();
    expect(within(issues).getByText("elements.0.xMm")).toBeTruthy();

    paste(
      "JSON шаблона",
      JSON.stringify({
        ...JSON_SPEC,
        elements: [{ ...JSON_SPEC.elements[0], widthMm: 120 }],
      }),
    );
    fireEvent.click(button("Проверить код"));
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Один из элементов больше этикетки. Исправьте код или разрешение.",
    );
  });

  it("warns that unsaved changes are replaced", () => {
    open({ unsaved: true });
    expect(
      screen.getByText("Несохранённый макет будет заменён, когда вы подтвердите импорт."),
    ).toBeTruthy();
  });

  it("lists the fields as placeholders for code and as bare names for JSON, each with a copy button", () => {
    open();
    const fields = screen.getByRole("region", { name: "Поля шаблона" });
    expect(within(fields).getByText("Название товара")).toBeTruthy();
    expect(within(fields).getByText("{{product.name}}")).toBeTruthy();
    expect(within(fields).getAllByRole("button", { name: /^Копировать / })).toHaveLength(13);
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    expect(within(fields).getByText("qty.boxes")).toBeTruthy();
    expect(within(fields).queryByText("{{qty.boxes}}")).toBeNull();
  });

  it("copies a field and says so, or says to copy it by hand", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    await act(async () => {
      fireEvent.click(button("Копировать {{sscc}}"));
    });
    expect(writeText).toHaveBeenCalledWith("{{sscc}}");
    expect(screen.getByText("Поле скопировано.")).toBeTruthy();

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      fireEvent.click(button("Копировать {{qty}}"));
    });
    expect(screen.queryByText("Поле скопировано.")).toBeNull();
    expect(screen.getByText("Не удалось скопировать. Выделите поле вручную.")).toBeTruthy();
  });

  // Extras beyond the plan (task 2 implementer): guards whose one-line mutants the plan's tests left alive.

  it("renders imported code, names and messages as text, never as markup", () => {
    const { dialog } = open();
    const markup = '<img src="x" onerror="alert(1)"><script>alert(2)</script><b>bold</b>';
    paste("Код ZPL", ZPL.replace("^XZ", `^GFA,${markup}\n^XZ`));
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText(`^GFA,${markup}`).closest("li")?.textContent).toBe(
      `Строка 6: ^GFA,${markup}`,
    );
    expect(dialog.querySelector("img, script, b")).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    // V8 quotes the start of the text it cannot parse, so the markup reaches the message.
    paste("JSON шаблона", "<b>x</b>");
    fireEvent.click(button("Проверить код"));
    expect(screen.getByRole("alert").textContent).toContain("<b>x</b>");
    expect(dialog.querySelector("img, script, b")).toBeNull();

    const twin = {
      kind: "line",
      id: "<i>a</i>",
      xMm: 2,
      yMm: 2,
      x2Mm: 9,
      y2Mm: 2,
      thicknessMm: 0.3,
    };
    paste("JSON шаблона", JSON.stringify({ ...JSON_SPEC, elements: [twin, twin] }));
    fireEvent.click(button("Проверить код"));
    expect(within(screen.getByRole("alert")).getByText(/<i>a<\/i>/)).toBeTruthy();
    expect(dialog.querySelector("i")).toBeNull();

    paste(
      "JSON шаблона",
      JSON.stringify({ ...JSON_SPEC, "<u>x</u>": 1, name: "<b>n</b>", purpose: "<s>p</s>" }),
    );
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("<u>x</u>").closest("li")?.textContent).toBe(
      "<u>x</u> — этого свойства нет в модели, оно будет отброшено",
    );
    expect(dialog.querySelector("u, s, b")).toBeNull();
  });

  it("names a property the model does not have and counts it as a warning", () => {
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    paste("JSON шаблона", JSON.stringify({ ...JSON_SPEC, foo: 1 }));
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Предупреждения: 1")).toBeTruthy();
    expect(screen.getByText("foo").closest("li")?.textContent).toBe(
      "foo — этого свойства нет в модели, оно будет отброшено",
    );
  });

  it("tells how many elements it moved inside the label, and only when it moved some", () => {
    open();
    paste("Код ZPL", ZPL);
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText(/^Распознано элементов/)).toBeTruthy();
    expect(screen.queryByText(/Прижато к границам/)).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    const hanging = {
      kind: "box",
      id: "frame",
      xMm: 40,
      yMm: 1,
      widthMm: 56,
      heightMm: 38,
      thicknessMm: 0.5,
    };
    paste("JSON шаблона", JSON.stringify({ ...JSON_SPEC, elements: [hanging] }));
    fireEvent.click(button("Проверить код"));
    expect(screen.getByText("Прижато к границам этикетки: 1")).toBeTruthy();
  });

  it("keeps «Проверить код» off for code that is only blanks", () => {
    open();
    paste("Код ZPL", "  \n\t ");
    expect(button("Проверить код")).toHaveProperty("disabled", true);
    paste("Код ZPL", ZPL);
    expect(button("Проверить код")).toHaveProperty("disabled", false);
  });

  it("does not replace the layout on a submit that skips the acknowledgement", async () => {
    const { onReplace, dialog } = open();
    paste("Код ZPL", ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ"));
    fireEvent.click(button("Проверить код"));
    const form = dialog.querySelector("form");
    expect(form).not.toBeNull();
    if (form === null) return;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(onReplace).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Импортировать без неподдерживаемых строк (1)" }),
    );
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("asks for the acknowledgement again after the code changes or is checked again", () => {
    open();
    const unsupported = ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ");
    const acknowledge = () =>
      screen.getByRole("checkbox", { name: "Импортировать без неподдерживаемых строк (1)" });
    paste("Код ZPL", unsupported);
    fireEvent.click(button("Проверить код"));
    fireEvent.click(acknowledge());
    expect(acknowledge().getAttribute("aria-checked")).toBe("true");
    expect(button("Заменить макет")).toHaveProperty("disabled", false);

    paste("Код ZPL", `${unsupported}\n`);
    fireEvent.click(button("Проверить код"));
    expect(acknowledge().getAttribute("aria-checked")).toBe("false");
    expect(button("Заменить макет")).toHaveProperty("disabled", true);

    fireEvent.click(acknowledge());
    fireEvent.click(button("Проверить код"));
    expect(acknowledge().getAttribute("aria-checked")).toBe("false");
    expect(button("Заменить макет")).toHaveProperty("disabled", true);
  });

  it("closes without replacing", () => {
    const { onClose, onReplace } = open();
    fireEvent.click(button("Отмена"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("words the field hint for the syntax of the chosen format", () => {
    open();
    const fields = screen.getByRole("region", { name: "Поля шаблона" });
    expect(within(fields).getByText("Вставьте поле целиком в текст или штрихкод.")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    expect(
      within(fields).getByText("Подставьте поле значением field у текста или data у штрихкода."),
    ).toBeTruthy();
    expect(within(fields).queryByText("Вставьте поле целиком в текст или штрихкод.")).toBeNull();
  });

  it("forgets a failed copy once the next one succeeds", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      fireEvent.click(button("Копировать {{qty}}"));
    });
    expect(screen.getByText("Не удалось скопировать. Выделите поле вручную.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(button("Копировать {{sscc}}"));
    });
    expect(screen.getByText("Поле скопировано.")).toBeTruthy();
    expect(screen.queryByText("Не удалось скопировать. Выделите поле вручную.")).toBeNull();
  });

  it("copies the bare field name for JSON", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    await act(async () => {
      fireEvent.click(button("Копировать qty.boxes"));
    });
    expect(writeText).toHaveBeenCalledWith("qty.boxes");
  });

  it("labels every field the domain can print", () => {
    open();
    const fields = screen.getByRole("region", { name: "Поля шаблона" });
    const expected: Array<[string, string]> = [
      ["Название товара", "{{product.name}}"],
      ["Наименование для печати", "{{product.printName}}"],
      ["GTIN товара", "{{product.gtin}}"],
      ["Код ЕГАИС", "{{product.egais}}"],
      ["Код маркировки", "{{km.code}}"],
      ["SSCC", "{{sscc}}"],
      ["№ смены", "{{shift.no}}"],
      ["Дата", "{{date}}"],
      ["Годен до", "{{expiry}}"],
      ["Количество", "{{qty}}"],
      ["Коробов на паллете", "{{qty.boxes}}"],
      ["Оператор", "{{operator}}"],
      ["Контрагент", "{{counterparty.name}}"],
    ];
    for (const [label, token] of expected) {
      expect(within(fields).getByText(token).parentElement?.textContent).toBe(`${label}${token}`);
    }
  });

  it("names the code field after the chosen format", () => {
    open();
    expect(screen.getByLabelText("Код ZPL")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "tspl" },
    });
    expect(screen.getByLabelText("Код TSPL (TSC)")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Формат кода" }), {
      target: { value: "json" },
    });
    expect(screen.getByLabelText("JSON шаблона")).toBeTruthy();
  });
});
