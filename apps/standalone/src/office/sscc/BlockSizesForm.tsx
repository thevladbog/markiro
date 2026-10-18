import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input } from "@markiro/ui";

import type { SsccState } from "../../host/protocol.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

/** The host's limits (`put_block_sizes`): 1-100 000 box serials, 1-10 000 pallet serials. */
const blockSizesSchema = z.object({
  boxBlockSize: z
    .number({ error: "office.sscc.errors.boxBlock" })
    .int("office.sscc.errors.boxBlock")
    .min(1, "office.sscc.errors.boxBlock")
    .max(100_000, "office.sscc.errors.boxBlock"),
  palletBlockSize: z
    .number({ error: "office.sscc.errors.palletBlock" })
    .int("office.sscc.errors.palletBlock")
    .min(1, "office.sscc.errors.palletBlock")
    .max(10_000, "office.sscc.errors.palletBlock"),
});
type BlockSizes = z.infer<typeof blockSizesSchema>;

const BLOCK_FIELDS = { boxBlockSize: "boxBlockSize", palletBlockSize: "palletBlockSize" } as const;

export interface BlockSizesFormProps {
  state: SsccState;
  onSaved: (state: SsccState) => void;
  onSubmitStart: () => void;
  onReload: () => void;
}

/** How many serials a station takes at a time; administrators only. */
export function BlockSizesForm({ state, onSaved, onSubmitStart, onReload }: BlockSizesFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, sizes: BlockSizes) =>
    api.updateBlockSizes(token, {
      boxBlockSize: sizes.boxBlockSize,
      palletBlockSize: sizes.palletBlockSize,
      expectedRev: state.blockSizesRev,
    }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<BlockSizes>({
    resolver: zodResolver(blockSizesSchema),
    defaultValues: { boxBlockSize: state.boxBlockSize, palletBlockSize: state.palletBlockSize },
  });

  const submit = handleSubmit(async (sizes) => {
    onSubmitStart();
    setFailure(null);
    let saved: SsccState;
    try {
      saved = await update.mutateAsync(sizes);
    } catch (error) {
      const outcome = writeFailure(error, BLOCK_FIELDS);
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
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      <WriteFailureAlert failure={failure} onReload={onReload} />
      <Input
        type="number"
        min={1}
        max={100_000}
        step={1}
        mono
        label={t("office.sscc.boxBlock")}
        hint={t("office.sscc.boxBlockHint")}
        {...fieldError(errors.boxBlockSize?.message)}
        {...register("boxBlockSize", { valueAsNumber: true })}
      />
      <Input
        type="number"
        min={1}
        max={10_000}
        step={1}
        mono
        label={t("office.sscc.palletBlock")}
        hint={t("office.sscc.palletBlockHint")}
        {...fieldError(errors.palletBlockSize?.message)}
        {...register("palletBlockSize", { valueAsNumber: true })}
      />
      <div className="standalone-form__actions">
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          {t("office.common.save")}
        </Button>
      </div>
    </form>
  );
}
