import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeLine } from "../../host/protocol.js";
import { lineCreate, lineMaxStations, lineUpdate } from "../../host/requests.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  activeStationsOnLine,
  lineFieldsSchema,
  STATIONS_IN_USE,
  stationsInUse,
  type LineFields,
} from "./line-form.js";

const LINE_FIELDS = { name: "name", maxStations: "maxStations" } as const;
/**
 * An active line already has the name, compared without case (`lines_active_name_key`); or more
 * devices work a shift of the line than the new limit (`line_stations_in_use`, plan 2b).
 */
const LINE_CONFLICTS = {
  line_name: { field: "name", message: "office.lines.errors.nameTaken" },
  line_stations_in_use: { field: "maxStations", message: STATIONS_IN_USE },
} as const;

/** What the dialog does: add a line, change an active one, or bring one back from the archive. */
export type LineDialogMode =
  { kind: "create" } | { kind: "rename"; line: OfficeLine } | { kind: "restore"; line: OfficeLine };

export interface LineDialogProps {
  mode: LineDialogMode;
  onClose: () => void;
  onSaved: (line: OfficeLine) => void;
  /** The line changed on the host: close and load the lines again. */
  onReload: () => void;
}

/**
 * A line's name and, for an active line, its limit of devices in one shift (plan 2b). A name an
 * active line already has (without case) comes back as `conflict` on `line_name` on every path
 * here — adding, changing and bringing a line back — and goes under the name, so bringing a line
 * back can give it a new name in the same dialog. The limit is not offered when a line is added
 * (it starts at one), or brought back; changing it below the devices at work is refused here as
 * soon as the shifts are read, and by the host (`line_stations_in_use`) whatever the page knew.
 */
export function LineDialog({ mode, onClose, onSaved, onReload }: LineDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // How many devices work the line, as the host last said when it refused a lower limit.
  const [hostInUse, setHostInUse] = useState<number | null>(null);
  const editsLimit = mode.kind === "rename";
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token), {
    enabled: editsLimit,
  });
  // The host's count leaves revoked devices out, so the devices are read too; unread, the host decides.
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    enabled: editsLimit,
  });
  // Shifts whose last read failed may be older than the host's state (data stays cached through a
  // failed read): the form then claims nothing and the host decides.
  const inUse =
    mode.kind === "rename" && !shifts.isError
      ? activeStationsOnLine(shifts.data, mode.line.id, devices.data)
      : null;
  const schema = useMemo(() => lineFieldsSchema(inUse), [inUse]);
  const save = useOfficeMutation((api, token, values: LineFields) => {
    switch (mode.kind) {
      case "create":
        return api.createLine(token, lineCreate(values.name));
      case "rename":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, {
            name: values.name,
            archived: mode.line.archived,
            maxStations: Number(values.maxStations),
          }),
        );
      case "restore":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, { name: values.name, archived: false }),
        );
    }
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<LineFields>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: mode.kind === "create" ? "" : mode.line.name,
      maxStations: mode.kind === "create" ? "1" : String(lineMaxStations(mode.line)),
    },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setHostInUse(null);
    let saved: OfficeLine;
    try {
      saved = await save.mutateAsync(values);
    } catch (error) {
      setHostInUse(stationsInUse(error));
      const outcome = writeFailure(error, LINE_FIELDS, LINE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  const title =
    mode.kind === "create"
      ? t("office.lines.createTitle")
      : mode.kind === "rename"
        ? t("office.lines.renameTitle", { name: mode.line.name })
        : t("office.lines.restoreTitle", { name: mode.line.name });
  const submitLabel =
    mode.kind === "create"
      ? t("office.lines.create")
      : mode.kind === "rename"
        ? t("office.common.save")
        : t("office.lines.restoreSubmit");
  const limitMessage = errors.maxStations?.message;

  return (
    <FormDialog
      errorCount={Object.keys(errors).length}
      title={title}
      submitLabel={submitLabel}
      submitDisabled={mode.kind === "rename" && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      {mode.kind === "restore" && <p>{t("office.lines.restoreIntro")}</p>}
      <Input
        label={t("office.lines.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      {editsLimit && (
        <Input
          label={t("office.lines.fields.maxStations")}
          hint={
            inUse !== null && inUse > 0
              ? t("office.lines.fields.maxStationsInUse", { count: inUse })
              : t("office.lines.fields.maxStationsHint")
          }
          inputMode="numeric"
          mono
          {...fieldError(
            limitMessage,
            limitMessage === STATIONS_IN_USE ? { count: hostInUse ?? inUse ?? 1 } : undefined,
          )}
          {...register("maxStations")}
        />
      )}
    </FormDialog>
  );
}
