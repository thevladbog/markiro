import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { SsccCounter } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { counterKindKey } from "./counter-kind.js";

const COUNTER_FIELDS = { nextSerial: "nextSerial" } as const;

interface CounterValues {
  nextSerial: number;
}

export interface CounterDialogProps {
  counter: SsccCounter;
  onClose: () => void;
  onSaved: (counter: SsccCounter) => void;
  /** The counter changed on the host: close and load the counters again. */
  onReload: () => void;
}

/** Moves one SSCC counter forward; it never goes back (spec §4.3). */
export function CounterDialog({ counter, onClose, onSaved, onReload }: CounterDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  // The smallest allowed value: the loaded counter, or the host's newer one.
  const [floor, setFloor] = useState(counter.nextSerial);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const schema = useMemo(
    () =>
      z.object({
        nextSerial: z
          .number({ error: "office.sscc.errors.range" })
          .int("office.sscc.errors.range")
          .min(floor, "office.sscc.errors.belowFloor")
          .max(counter.maxSerial, "office.sscc.errors.range"),
      }),
    [floor, counter.maxSerial],
  );
  const update = useOfficeMutation((api, token, nextSerial: number) =>
    api.updateSsccCounter(
      token,
      { issuerPrefix: counter.issuerPrefix, extension: counter.extension },
      { nextSerial, expectedRev: counter.rev },
    ),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<CounterValues>({
    resolver: zodResolver(schema),
    defaultValues: { nextSerial: counter.nextSerial },
  });
  const limits = { min: floor, max: counter.maxSerial };
  const kind = t(counterKindKey(counter), { extension: counter.extension });

  const submit = handleSubmit(async ({ nextSerial }) => {
    setFailure(null);
    let saved: SsccCounter;
    try {
      saved = await update.mutateAsync(nextSerial);
    } catch (error) {
      if (error instanceof HostError && error.code === "sscc_below_floor") {
        const minSerial = error.details.minSerial;
        if (typeof minSerial === "number") setFloor(minSerial);
        setError("nextSerial", { type: "server", message: "office.sscc.errors.belowFloor" });
        return;
      }
      const outcome = writeFailure(error, COUNTER_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <FormDialog
      title={t("office.sscc.counterDialog.title", { kind, prefix: counter.issuerPrefix })}
      submitLabel={t("office.common.save")}
      submitDisabled={!isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <p>{t("office.sscc.counterDialog.intro")}</p>
      <Input
        type="number"
        min={floor}
        max={counter.maxSerial}
        step={1}
        mono
        label={t("office.sscc.counterDialog.field")}
        hint={t("office.sscc.counterDialog.hint", limits)}
        {...fieldError(errors.nextSerial?.message, limits)}
        {...register("nextSerial", { valueAsNumber: true })}
      />
    </FormDialog>
  );
}
