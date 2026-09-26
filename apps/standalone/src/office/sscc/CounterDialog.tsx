import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { SsccCounter } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { writeFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert } from "../page-state.js";
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
  const formId = useId();
  // The smallest allowed value: the loaded counter, or the host's newer one.
  const [floor, setFloor] = useState(counter.nextSerial);
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
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
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CounterValues>({
    resolver: zodResolver(schema),
    defaultValues: { nextSerial: counter.nextSerial },
  });
  const limits = { min: floor, max: counter.maxSerial };
  const message = errors.nextSerial?.message;
  const kind = t(counterKindKey(counter), { extension: counter.extension });

  const close = () => {
    if (isSubmitting) return;
    onClose();
  };

  const submit = handleSubmit(async ({ nextSerial }) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(nextSerial));
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
    }
  });

  return (
    <Modal
      open
      title={t("office.sscc.counterDialog.title", { kind, prefix: counter.issuerPrefix })}
      onClose={close}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={isSubmitting}>
            {t("office.common.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={isSubmitting} disabled={!isDirty}>
            {t("office.common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="standalone-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
        {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
        <p>{t("office.sscc.counterDialog.intro")}</p>
        <Input
          type="number"
          min={floor}
          max={counter.maxSerial}
          step={1}
          mono
          label={t("office.sscc.counterDialog.field")}
          hint={t("office.sscc.counterDialog.hint", limits)}
          {...errorProp(message === undefined ? undefined : t(message, limits))}
          {...register("nextSerial", { valueAsNumber: true })}
        />
      </form>
    </Modal>
  );
}
