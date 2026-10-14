import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfficeFilesError } from "../src/office/exports/office-files.js";
import {
  actFolder,
  formFileName,
  formFolder,
  openInBrowser,
  PRINT_FRAME_ID,
  printInFrame,
} from "../src/office/forms/print-form.js";
import type { RenderedForm } from "../src/office/forms/render-form.js";
import { fakeOfficeFiles } from "./support/office-files.js";

describe("an act's folder (plan ДЗГ-О)", () => {
  it("is Формы\\Дезагрегация\\<номер>\\<дата_время>_act_<вариант> in the organization's time", () => {
    expect(actFolder("DSG-26-0007", "full", "2026-10-12T21:30:00.000Z", "Europe/Moscow")).toEqual([
      "Формы",
      "Дезагрегация",
      "DSG-26-0007",
      "2026-10-13_00-30-00_act_full",
    ]);
  });
});

const FORM: RenderedForm = {
  kind: "placard",
  html: '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>@page { size: A5; margin: 0 }</style></head><body><p>Ярлык паллеты</p></body></html>',
  fileName: "Ярлык паллеты 146006820000000409 A5.html",
};

/** What a frame's window and document were asked, in order; the test's `print` pushes `print`. */
const order: string[] = [];
/** The `afterprint` listeners the frames were given, in order of printing. */
const afterPrint: Array<() => void> = [];

beforeEach(() => {
  order.length = 0;
  afterPrint.length = 0;
  // jsdom's `focus()` only logs «Not implemented», and erases no listener on `open()`: the
  // window and the document of a frame get stand-ins that note the calls the order matters for.
  const window$ = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentWindow",
  )?.get;
  const document$ = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentDocument",
  )?.get;
  vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockImplementation(function (
    this: HTMLIFrameElement,
  ) {
    const view = (window$?.call(this) as Window | null | undefined) ?? null;
    if (view !== null) {
      view.focus = () => {
        order.push("focus");
      };
      const listen = view.addEventListener.bind(view);
      view.addEventListener = ((type: string, listener: () => void, options?: unknown) => {
        if (type !== "afterprint") {
          listen(type, listener, options as AddEventListenerOptions);
          return;
        }
        order.push("listen afterprint");
        afterPrint.push(listener);
      }) as Window["addEventListener"];
    }
    return view;
  });
  vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockImplementation(function (
    this: HTMLIFrameElement,
  ) {
    const written = (document$?.call(this) as Document | null | undefined) ?? null;
    if (written !== null && !("noted" in written)) {
      const open = written.open.bind(written);
      const close = written.close.bind(written);
      Object.assign(written, {
        noted: true,
        open: (...args: []) => {
          order.push("open");
          return open(...args);
        },
        close: () => {
          order.push("close");
          close();
        },
      });
    }
    return written;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.getElementById(PRINT_FRAME_ID)?.remove();
});

describe("printing a form (plan О-Ф)", () => {
  it("writes the form into one hidden frame and prints that frame, not the office", () => {
    const printed: string[] = [];
    printInFrame(FORM.html, document, (view) => {
      printed.push(view.document.documentElement.outerHTML);
    });
    const frame = document.getElementById(PRINT_FRAME_ID);
    expect(frame).toBeInstanceOf(HTMLIFrameElement);
    expect(frame?.getAttribute("aria-hidden")).toBe("true");
    expect(frame?.tabIndex).toBe(-1);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("@page { size: A5; margin: 0 }");
    expect(printed[0]).toContain("Ярлык паллеты");
    expect(document.body.textContent).not.toContain("Ярлык паллеты");
  });

  it("replaces the frame of the form before, so there is only ever one", () => {
    const print = vi.fn<(view: Window) => void>();
    printInFrame("<p>first</p>", document, print);
    printInFrame("<p>second</p>", document, print);
    expect(document.querySelectorAll(`#${PRINT_FRAME_ID}`)).toHaveLength(1);
    const frame = document.getElementById(PRINT_FRAME_ID);
    expect(frame instanceof HTMLIFrameElement && frame.contentDocument?.body.textContent).toBe(
      "second",
    );
    expect(print).toHaveBeenCalledTimes(2);
  });

  it("writes the form, hears the end of the print, focuses the frame and only then prints it", () => {
    printInFrame(FORM.html, document, () => {
      order.push("print");
    });
    expect(order).toEqual(["open", "close", "listen afterprint", "focus", "print"]);
  });

  it("sandboxes the frame: the form may print but no script of it, or of its data, may run", () => {
    printInFrame(FORM.html, document, () => undefined);
    const frame = document.getElementById(PRINT_FRAME_ID);
    const flags = (frame?.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect([...flags].sort()).toEqual(["allow-modals", "allow-same-origin"]);
  });

  it("takes the frame away when the print is over, and only its own frame", () => {
    printInFrame("<p>first</p>", document, () => undefined);
    printInFrame("<p>second</p>", document, () => undefined);
    const [first, second] = afterPrint;
    // The dialog of the first form closes late: the second form's frame stays.
    first?.();
    expect(document.getElementById(PRINT_FRAME_ID)).not.toBeNull();
    second?.();
    expect(document.getElementById(PRINT_FRAME_ID)).toBeNull();
  });

  it("takes the frame away when printing fails, and says so", () => {
    expect(() =>
      printInFrame(FORM.html, document, () => {
        throw new Error("no print here");
      }),
    ).toThrow("no print here");
    expect(document.getElementById(PRINT_FRAME_ID)).toBeNull();
  });

  it("makes no blob and no object URL of the form", () => {
    const create = vi.fn<(object: Blob) => string>(() => "blob:x");
    const before = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true });
    try {
      printInFrame(FORM.html, document, () => undefined);
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) Reflect.deleteProperty(URL, "createObjectURL");
      else Object.defineProperty(URL, "createObjectURL", before);
    }
  });

  it("puts a form's file in its own folder under «Формы», named by the shift and the moment", () => {
    expect(
      formFolder("OCT26-004/S", "placards", "2026-10-08T15:30:00.000Z", "Europe/Moscow"),
    ).toEqual(["Формы", "OCT26-004_S", "2026-10-08_18-30-00_placards"]);
  });

  it("saves the form's HTML as UTF-8 and opens the file it saved, « (2)» included", async () => {
    const files = fakeOfficeFiles();
    files.save.mockImplementation(async (segments, saved) => ({
      segments: [...segments.slice(0, -1), `${segments.at(-1) ?? ""} (2)`],
      path: "C:\\Users\\Оператор\\Documents\\Markiro\\Формы",
      files: saved.map((file) => file.name),
    }));
    const folder = ["Формы", "OCT26-004", "2026-10-08_18-30-00_placard"];
    const saved = await openInBrowser(files, FORM, folder);
    expect(files.save).toHaveBeenCalledWith(folder, [
      { name: FORM.fileName, bytes: new TextEncoder().encode(FORM.html) },
    ]);
    expect(files.openFile).toHaveBeenCalledWith(
      ["Формы", "OCT26-004", "2026-10-08_18-30-00_placard (2)"],
      FORM.fileName,
    );
    expect(saved.segments.at(-1)).toBe("2026-10-08_18-30-00_placard (2)");
  });

  it("opens nothing when the file was not saved, and says why", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no folder"));
    await expect(openInBrowser(files, FORM, ["Формы", "OCT26-004", "x"])).rejects.toMatchObject({
      code: "documents_unavailable",
    });
    expect(files.openFile).not.toHaveBeenCalled();
  });

  it("saves and opens the file under the name the shell takes, whatever the host's SSCC text was", async () => {
    const files = fakeOfficeFiles();
    const odd: RenderedForm = { ...FORM, fileName: "Состав короба 0460/..\\68,2%;&.html" };
    await openInBrowser(files, odd, ["Формы", "OCT26-004", "x"]);
    const name = files.save.mock.calls[0]?.[1][0]?.name;
    expect(name).toBe("Состав короба 0460_.._68_2___.html");
    expect(files.openFile).toHaveBeenCalledWith(["Формы", "OCT26-004", "x"], name);
  });
});

describe("the name of a form's file (plan О-Ф)", () => {
  it("keeps every name the forms make", () => {
    for (const name of [
      "Состав короба 046006820000015000.html",
      "Состав короба без SSCC.html",
      "Состав паллеты 146006820000000409.html",
      "Ярлык паллеты 146006820000000409 A5.html",
      "Ярлык паллеты  A4.html",
      "Ярлыки паллет смены A5.html",
      "Бланк смены.html",
    ]) {
      expect(formFileName(name), name).toBe(name);
    }
  });

  it("writes every character the shell refuses as an underscore", () => {
    expect(formFileName('a,b;c&d%e~f$g^h/i\\j:k*l?m"n<o>p|q\u200br\u202es\u00a0t.html')).toBe(
      "a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p_q_r_s_t.html",
    );
    expect(formFileName("Форма (2)-а_б.html")).toBe("Форма (2)-а_б.html");
  });

  it("ends in .html whatever came in, and never in a dot or a space before it", () => {
    expect(formFileName("Бланк.exe")).toBe("Бланк.exe.html");
    expect(formFileName("Бланк. .html")).toBe("Бланк.html");
    expect(formFileName("Бланк")).toBe("Бланк.html");
    expect(formFileName("Бланк.HTML")).toBe("Бланк.html");
  });

  it("is never empty, a device name or longer than the shell takes", () => {
    expect(formFileName("")).toBe("Форма.html");
    expect(formFileName("..html")).toBe("Форма.html");
    expect(formFileName(",,,.html")).toBe("___.html");
    expect(formFileName("con.html")).toBe("Форма con.html");
    expect(formFileName("COM1.html")).toBe("Форма COM1.html");
    expect(formFileName("LPT¹.html")).toBe("Форма LPT¹.html");
    expect(formFileName("com10.html")).toBe("com10.html");
    // Cut where a space is the last character kept: it does not end the name.
    expect(formFileName(`${"я".repeat(99)} zzz.html`)).toBe(`${"я".repeat(99)}.html`);
    const long = formFileName(`${"я".repeat(300)}.html`);
    expect(long).toBe(`${"я".repeat(100)}.html`);
    expect(Array.from(formFileName(`${"𠀀".repeat(300)}.html`))).toHaveLength(55);
  });
});
