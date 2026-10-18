import type { ExportTargetType } from "../../host/export-files.js";
import { formFileName } from "./print-form.js";
import type { FormKind } from "./render-form.js";
import { storeExportFiles, type StoreSession } from "../exports/stored-files.js";

/** What a printed form belongs to on the host: the card its copy is listed on. */
export interface FormTarget {
  type: ExportTargetType;
  id: string;
}

/**
 * Keeps a printed form's HTML on the host (host migration `0029`), the exact
 * bytes the «Открыть в браузере» file has, so the form can be had again from
 * the shift's drawer and the card it was printed from, whether it was printed
 * or saved. Answers the words for why the host could not keep it, or `null`
 * when it did: a form is printed or opened all the same.
 */
export async function storeForm(
  session: StoreSession,
  form: { kind: FormKind; html: string; fileName: string },
  target: FormTarget,
): Promise<string | null> {
  const stored = await storeExportFiles(session, {
    kind: "form",
    targetType: target.type,
    targetId: target.id,
    batchId: crypto.randomUUID(),
    formatId: `form_${form.kind}`,
    formatVersion: 1,
    parts: [
      { partNo: 1, name: formFileName(form.fileName), bytes: new TextEncoder().encode(form.html) },
    ],
  });
  return stored.ok ? null : stored.messageKey;
}
