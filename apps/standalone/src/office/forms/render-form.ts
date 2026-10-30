import {
  DISAGGREGATION_MANUAL_UPLOAD_NOTE,
  renderBoxReportHtml,
  renderDisaggregationReportHtml,
  renderPalletPlacardHtml,
  renderPalletReportHtml,
  renderShiftPlacardsHtml,
  renderShiftTaskFormHtml,
  type PlacardFormat,
} from "@markiro/domain";

import type { DisaggregationReportRows } from "../../host/disaggregation.js";
import type { BoxReportRows, OrgProfile, PalletReportRows } from "../../host/protocol.js";
import { isKnownTimeZone } from "../../lib/civil-date.js";
import { requireHistoryTimeZone } from "../import/history-time-zone.js";
import { actData } from "../disaggregation/act-data.js";
import {
  boxReportData,
  palletPlacardData,
  palletReportData,
  shiftPlacardsData,
  taskFormData,
  type TaskFormInputs,
} from "./form-data.js";

/** The printed forms of a shift (pilot spec §5.5), as the cloud's routes serve them. */
export type FormKind = "box" | "pallet" | "placard" | "placards" | "task" | "act";

/** A form to draw and the host's rows (or the office's records) it is drawn from. */
export type FormRequest = (
  | { kind: "box"; rows: BoxReportRows; timeZone: string }
  | { kind: "pallet"; rows: PalletReportRows; palletId: string; timeZone: string }
  | { kind: "placard"; rows: PalletReportRows; palletId: string; format: PlacardFormat }
  | { kind: "placards"; rows: PalletReportRows; format: PlacardFormat }
  | { kind: "task"; inputs: TaskFormInputs; generatedAt: Date }
  // «Акт дезагрегации» of a disaggregation document (plan ДЗГ-О), of any status.
  | { kind: "act"; rows: DisaggregationReportRows; timeZone: string }
) & {
  /**
   * The organization's own print logo as a PNG data URL (custom branding, a
   * license feature); left out, every form prints the Markiro logo.
   */
  logo?: string | null;
};

/** A drawn form: its HTML, exactly the cloud's for the same input, and its file's name. */
export interface RenderedForm {
  kind: FormKind;
  html: string;
  fileName: string;
}

/**
 * The time zone the forms write times in: the organization's, as the cloud
 * cabinet writes them in its viewer's; this PC's while the profile is not
 * read or names a zone this PC lacks.
 */
export function formTimeZone(organization: OrgProfile | undefined): string {
  return organization !== undefined && isKnownTimeZone(organization.timeZone)
    ? organization.timeZone
    : new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** «A4» or «A5» in a file's name. */
function paper(format: PlacardFormat): string {
  return format.toUpperCase();
}

/**
 * A form whose data the cloud accepts, with its HTML still to draw: `draw`
 * is the heavy part (the domain's markup and barcodes, long for a pallet of
 * hundreds of boxes or a shift of hundreds of pallets), so a caller that
 * wants to show progress or to let go of the window first prepares, yields,
 * then draws.
 */
export interface PreparedForm {
  kind: FormKind;
  fileName: string;
  draw: () => string;
}

/**
 * The form's data and file name, or `null` when the cloud would refuse it:
 * a pallet the rows lack, a placard of a pallet not closed or without an
 * SSCC (`PALLET_NOT_CLOSED`), a shift with no pallet to placard
 * (`SHIFT_HAS_NO_PALLETS`), the blank of a closed shift
 * (`SHIFT_TASK_FORM_CLOSED`). Nothing is drawn yet.
 */
export function prepareForm(request: FormRequest): PreparedForm | null {
  const logo = request.logo ?? null;
  switch (request.kind) {
    case "box": {
      const data = boxReportData(request.rows, logo);
      return {
        kind: "box",
        draw: () =>
          renderBoxReportHtml(
            data,
            request.rows.organization.timeZone === undefined
              ? request.timeZone
              : requireHistoryTimeZone(request.rows.organization.timeZone),
          ),
        fileName: `Состав короба ${request.rows.sscc ?? "без SSCC"}.html`,
      };
    }
    case "pallet": {
      const data = palletReportData(request.rows, request.palletId, logo);
      if (data === null) return null;
      const sscc = request.rows.pallets.find((each) => each.id === request.palletId)?.sscc;
      return {
        kind: "pallet",
        draw: () =>
          renderPalletReportHtml(
            data,
            request.rows.organization.timeZone === undefined
              ? request.timeZone
              : requireHistoryTimeZone(request.rows.organization.timeZone),
          ),
        fileName: `Состав палета ${sscc ?? "без SSCC"}.html`,
      };
    }
    case "placard": {
      const data = palletPlacardData(request.rows, request.palletId, logo);
      if (data === null) return null;
      const sscc = request.rows.pallets.find((each) => each.id === request.palletId)?.sscc;
      return {
        kind: "placard",
        draw: () => renderPalletPlacardHtml(data, request.format),
        fileName: `Ярлык палета ${sscc ?? ""} ${paper(request.format)}.html`,
      };
    }
    case "placards": {
      const data = shiftPlacardsData(request.rows, logo);
      if (data === null) return null;
      return {
        kind: "placards",
        draw: () => renderShiftPlacardsHtml(data.pallets, request.format, data.shiftNumber),
        fileName: `Ярлыки палетов смены ${paper(request.format)}.html`,
      };
    }
    case "task": {
      const data = taskFormData(request.inputs, request.generatedAt, logo);
      if (data === null) return null;
      return {
        kind: "task",
        draw: () => renderShiftTaskFormHtml(data),
        fileName: "Бланк смены.html",
      };
    }
    case "act": {
      // The cloud prints an act of any status, so there is no refusal. The
      // note replaces the cloud's «передаются в ГИС МТ автоматически»: the
      // standalone sends nothing, a person uploads the file.
      const data = actData(request.rows, logo);
      return {
        kind: "act",
        draw: () =>
          renderDisaggregationReportHtml(
            { ...data, operationNote: DISAGGREGATION_MANUAL_UPLOAD_NOTE },
            request.timeZone,
          ),
        fileName: `Акт дезагрегации ${request.rows.docNo}.html`,
      };
    }
  }
}

/**
 * The form drawn by `@markiro/domain`, or `null` when the cloud would refuse
 * it (see `prepareForm`).
 */
export function renderForm(request: FormRequest): RenderedForm | null {
  const prepared = prepareForm(request);
  return prepared === null
    ? null
    : { kind: prepared.kind, html: prepared.draw(), fileName: prepared.fileName };
}
