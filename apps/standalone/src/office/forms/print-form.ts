import { exportFolder } from "../exports/export-checks.js";
import type { OfficeFilesApi, SavedFolder } from "../exports/office-files.js";
import type { FormKind, RenderedForm } from "./render-form.js";

/**
 * How the office prints a form (plan О-Ф): the cloud cabinet opens the
 * form's HTML in a new tab and the browser prints it through its `@page`
 * size; the standalone has no tab. Two ways, both offline and without a new
 * dependency, both offered next to each other (no failure of the first can
 * be seen to offer the second):
 *
 * - «Печать»: the HTML is written into a hidden frame of the office's own
 *   window and that frame prints, so WebView2 shows its print dialog for the
 *   form alone, A4 or A5 by the form's `@page`;
 * - «Открыть в браузере»: the HTML is saved as a file under
 *   `Документы\Markiro\Формы` and the shell opens it in the default browser,
 *   where it prints as the cloud's tab does.
 */

/** The id of the one frame the office prints through; each print replaces it. */
export const PRINT_FRAME_ID = "office-print-frame";

/** Prints the window of a frame; tests pass their own. */
export type PrintWindow = (view: Window) => void;

/**
 * What the frame's document may do: print (`allow-modals` — a sandboxed
 * document's `print()` is refused without it) and be written into by the
 * office (`allow-same-origin`). Never `allow-scripts`: the forms are static
 * HTML, so a script that got into one through the data it prints (a product
 * name, a lot) does not run, and with `allow-same-origin` it could otherwise
 * reach the office's own window.
 */
const FRAME_SANDBOX = "allow-same-origin allow-modals";

/**
 * Writes `html` into a new hidden frame of `doc` (the frame before it, kept
 * until its print was over in case its dialog was still open, goes) and
 * prints that frame; the frame goes when its print is over. The frame is
 * same-origin `about:blank`, so the window's CSP holds for the form too: its
 * inline styles and inline SVG are allowed, and it loads nothing from the
 * network. No blob or object URL is made, so there is nothing to revoke.
 */
export function printInFrame(
  html: string,
  doc: Document = document,
  print: PrintWindow = (view) => view.print(),
  imageWaitMs: number = IMAGE_WAIT_MS,
): void | Promise<void> {
  doc.getElementById(PRINT_FRAME_ID)?.remove();
  const frame = doc.createElement("iframe");
  frame.id = PRINT_FRAME_ID;
  frame.title = "print";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  doc.body.append(frame);
  try {
    const view = frame.contentWindow;
    const written = frame.contentDocument;
    if (view === null || written === null) {
      throw new Error("the print frame has no document");
    }
    written.open();
    written.write(html);
    written.close();
    // After `open`, which erases the listeners of the window it is given. The
    // frame of this print only: a later print has replaced it by then.
    view.addEventListener("afterprint", () => frame.remove(), { once: true });
    view.focus();
    const pending = pendingImages(written);
    if (pending.length === 0) {
      print(view);
      return;
    }
    // A picture of the form (the organization's logo is a data URL) decodes after the write;
    // a frame printed at once prints the form without it. Print when they are in.
    return imagesSettled(pending, imageWaitMs).then(() => {
      // A later print has replaced this frame while the pictures loaded: nothing to print.
      if (!frame.isConnected) return;
      try {
        print(view);
      } catch (error) {
        frame.remove();
        throw error;
      }
    });
  } catch (error) {
    frame.remove();
    throw error;
  }
}

/** The longest the print waits for the pictures of a form; a picture that never loads is printed without. */
export const IMAGE_WAIT_MS = 5000;

/** The pictures of the document that have not finished loading (or failing to). */
function pendingImages(written: Document): HTMLImageElement[] {
  return Array.from(written.images).filter((image) => !image.complete);
}

/** Resolves once every picture has loaded or failed, or after `waitMs`. */
function imagesSettled(images: readonly HTMLImageElement[], waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let left = images.length;
    const timer = setTimeout(resolve, waitMs);
    const one = () => {
      left -= 1;
      if (left === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const image of images) {
      image.addEventListener("load", one, { once: true });
      image.addEventListener("error", one, { once: true });
    }
  });
}

/**
 * Lets the window paint what the press has said (a frame and a turn after it)
 * before the heavy work blocks it. A window that draws no frames (hidden,
 * minimised) waits no longer than 100 ms.
 */
export function paint(): Promise<void> {
  return new Promise((resolve) => {
    let waiting = true;
    const finish = () => {
      if (waiting) {
        waiting = false;
        resolve();
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(finish, 0));
    }
    setTimeout(finish, 100);
  });
}

/**
 * Where a form's file goes for «Открыть в браузере», as the shell's segments
 * under `Документы\Markiro`: `Формы\<номер смены>\<дата_время>_<форма>`, the
 * number and the moment written as an export's folder writes them (plan ЧЗ),
 * one new folder a form.
 */
export function formFolder(
  shiftNumber: string,
  kind: FormKind,
  formedAt: string,
  timeZone: string,
): string[] {
  return ["Формы", ...exportFolder(shiftNumber, kind, formedAt, timeZone).slice(1)];
}

/**
 * Where «Акт дезагрегации» goes for «Открыть в браузере» (plan ДЗГ-О):
 * `Формы\Дезагрегация\<номер>\<дата_время>_act_<вариант>`, four segments.
 */
export function actFolder(
  docNo: string,
  variant: "boxes" | "full",
  formedAt: string,
  timeZone: string,
): string[] {
  return [
    "Формы",
    "Дезагрегация",
    ...exportFolder(docNo, `act_${variant}`, formedAt, timeZone).slice(1),
  ];
}

/** The longest stem of a file name, in UTF-16 units: the shell bounds the whole path. */
const MAX_STEM_UNITS = 100;

/** A name Windows reserves for a device, with an extension or not. */
const DEVICE_NAME = /^(con|prn|aux|nul|(com|lpt)[1-9¹²³])$/iu;

/**
 * The name of a form's file as the shell takes it: letters and digits of any
 * script, spaces and `-_.()` only (the shell's allowlist, `is_plain_name`),
 * ending in `.html`. The forms' own names carry the host's SSCC text, which
 * is digits, but this is the boundary before the shell: a name that is
 * not such text arrives as underscores and is never a refusal that stops a
 * form from opening. A name the shell takes is returned as it is.
 */
export function formFileName(name: string): string {
  const stem = name
    .replace(/\.html$/iu, "")
    .replace(/[^\p{L}\p{N} _().-]/gu, "_")
    .replace(/[. ]+$/u, "");
  let kept = "";
  for (const letter of stem) {
    if (kept.length + letter.length > MAX_STEM_UNITS) break;
    kept += letter;
  }
  const trimmed = kept.replace(/[. ]+$/u, "");
  const named = trimmed === "" ? "Форма" : trimmed;
  const device = DEVICE_NAME.test((named.split(".")[0] ?? "").trimEnd());
  return `${device ? "Форма " : ""}${named}.html`;
}

/**
 * Saves the form's HTML, UTF-8 as its `<meta charset>` says, into `folder`
 * and opens it in the default browser; answers where it went, so the dialog
 * can name it and show the folder. The file is opened by the folder the
 * shell made (« (2)» when the name was taken), under the name it was saved by.
 */
export async function openInBrowser(
  files: OfficeFilesApi,
  form: RenderedForm,
  folder: readonly string[],
): Promise<SavedFolder> {
  const name = formFileName(form.fileName);
  const saved = await files.save(folder, [{ name, bytes: new TextEncoder().encode(form.html) }]);
  await files.openFile(saved.segments, name);
  return saved;
}
