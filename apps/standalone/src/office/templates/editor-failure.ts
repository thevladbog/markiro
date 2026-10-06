import { HostError } from "../../host/client.js";
import {
  alertFailure,
  writeFailure,
  type FieldMessage,
  type WriteFailure,
} from "../form-errors.js";
import { defaultConflict, type DefaultConflict, type TemplateFailure } from "./template-text.js";

/** The editor's controls a refusal can go under. */
export type EditorField = "name" | "scope";

/** A refused save: under a control, above the form, or the defaults in its way. */
export type EditorFailure =
  WriteFailure<EditorField> | { kind: "default"; conflict: DefaultConflict };

const EDITOR_FIELDS: Readonly<Record<string, EditorField | FieldMessage<EditorField>>> = {
  name: "name",
  chzProductGroupCodes: { field: "scope", message: "office.templateEditor.errors.scopeRejected" },
};

/**
 * Sorts a refused create or update of a template: a template that is a
 * default (`template_is_default`: switched off or narrowed out of its slot)
 * says whose; a stock template's name or layout (`stock_template`), a layout
 * the host would not keep (`spec`: over 256 KB or 64 levels) and a template
 * deleted since it was opened (`not_found`) are explained above the form; a
 * name or categories the host refused go under their control; the rest is
 * `writeFailure`'s (`stale_revision` offers to reload).
 */
export function editorFailure(error: unknown): EditorFailure {
  const conflict = defaultConflict(error);
  if (conflict !== null) return { kind: "default", conflict };
  if (error instanceof HostError) {
    if (error.code === "conflict" && error.details.constraint === "stock_template") {
      return { kind: "alert", message: "office.templateEditor.errors.stock" };
    }
    if (error.code === "validation_failed" && error.field === "spec") {
      return { kind: "alert", message: "office.templateEditor.errors.specRejected" };
    }
    if (error.code === "not_found") {
      return { kind: "alert", message: "office.templateEditor.errors.missing" };
    }
  }
  return writeFailure(error, EDITOR_FIELDS);
}

/**
 * A refused delete, above the dialog: a default says whose (`template_is_default`),
 * a stock template is never deleted (`stock_template`), a template deleted
 * elsewhere is gone (`not_found`, which the host answers only for an id it
 * never had, so this is defensive), the rest is explained by its code.
 */
export function deleteFailure(error: unknown): TemplateFailure {
  const conflict = defaultConflict(error);
  if (conflict !== null) return { kind: "default", conflict };
  if (error instanceof HostError) {
    if (error.code === "conflict" && error.details.constraint === "stock_template") {
      return { kind: "alert", message: "office.templateEditor.errors.stockDelete" };
    }
    if (error.code === "not_found") {
      return { kind: "alert", message: "office.templateEditor.errors.missing" };
    }
  }
  return alertFailure(error);
}
