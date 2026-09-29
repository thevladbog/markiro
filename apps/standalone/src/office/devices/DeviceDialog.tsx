import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input, Select } from "@markiro/ui";

import type { DeviceRecord, OfficeLine } from "../../host/protocol.js";
import { deviceUpdate } from "../../host/requests.js";
import { deviceNameRule } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { lineLabel } from "./line-label.js";

/** `lineId` is the chosen line's id, or `""` for none. */
const deviceFieldsSchema = z.object({ name: deviceNameRule, lineId: z.string() });
type DeviceFields = z.input<typeof deviceFieldsSchema>;

/** The host refuses a line that is archived or gone (`no such active line`). */
const DEVICE_FIELDS = {
  name: "name",
  lineId: { field: "lineId", message: "office.devices.errors.lineRejected" },
} as const;

export interface DeviceDialogProps {
  device: DeviceRecord;
  /** The host's lines, archived ones included (`GET /v1/office/lines`). */
  lines: readonly OfficeLine[];
  onClose: () => void;
  onSaved: (device: DeviceRecord) => void;
}

/**
 * Renames a device and, for a station, sets its line. Only the fields that
 * changed are sent (`deviceUpdate`). A line can be chosen only among the
 * active ones; a station's current line stays on the list even when it has
 * been archived since, and keeping it sends nothing for the line.
 */
export function DeviceDialog({ device, lines, onClose, onSaved }: DeviceDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: DeviceFields) =>
    api.updateDevice(
      token,
      device.id,
      deviceUpdate(device, {
        name: values.name,
        lineId: values.lineId === "" ? null : values.lineId,
      }),
    ),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<DeviceFields>({
    resolver: zodResolver(deviceFieldsSchema),
    defaultValues: { name: device.name, lineId: device.lineId ?? "" },
  });

  const options: { value: string; label: string }[] = [
    { value: "", label: t("office.devices.noLine") },
    ...activeFirstByName(lines.filter((line) => !line.archived)).map((line) => ({
      value: line.id,
      label: line.name,
    })),
  ];
  if (device.lineId !== null && !options.some((option) => option.value === device.lineId)) {
    options.push({ value: device.lineId, label: lineLabel(lines, device.lineId, t) });
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await save.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, DEVICE_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <FormDialog
      title={t("office.devices.editTitle", { name: device.name })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} />}
    >
      <Input
        label={t("office.devices.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      {device.kind === "station" && (
        <Controller
          control={control}
          name="lineId"
          render={({ field }) => (
            <Select
              native
              label={t("office.devices.fields.line")}
              hint={t("office.devices.fields.lineHint")}
              options={options}
              value={field.value}
              onValueChange={field.onChange}
              {...fieldError(errors.lineId?.message)}
            />
          )}
        />
      )}
    </FormDialog>
  );
}
