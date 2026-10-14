import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplateSpec } from "@markiro/domain";
import { Alert, Input, Select } from "@markiro/ui";

import type { TemplatePurpose } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import { FormDialog } from "../FormDialog.js";
import {
  DPI_CHOICES,
  parseSizeMm,
  presetOf,
  resizedSpec,
  SIZE_PRESETS,
  toDpi,
} from "./editor-model.js";

/** Millimetres as the office writes them: «58», «58,06». */
const MM = new Intl.NumberFormat("ru", { maximumFractionDigits: 2 });

export interface LabelSizeDialogProps {
  spec: LabelTemplateSpec;
  /** Whose sample data measures the elements. */
  purpose: TemplatePurpose;
  onClose: () => void;
  /** The layout at its new size and resolution; the dialog closes. */
  onResize: (spec: LabelTemplateSpec) => void;
}

/**
 * The label's size and the layout's resolution, after the cloud editor's
 * size select and «Свой размер» fields: a preset fills both fields, and a
 * typed size (10–300 mm, a comma or a point) shows as «Свой размер» unless a
 * preset has it. «Применить» moves every element inside the new label
 * (`resizedSpec`) or, when an element is larger than it, keeps the layout
 * and says so. An axis the user never touched (typed in, or set by a preset)
 * keeps its exact value, which the field shows rounded; once touched, its
 * text is its value, even when it is typed back to the text shown.
 */
export function LabelSizeDialog({ spec, purpose, onClose, onResize }: LabelSizeDialogProps) {
  const { t } = useTranslation();
  const shownWidth = MM.format(spec.widthMm);
  const shownHeight = MM.format(spec.heightMm);
  const [width, setWidth] = useState(shownWidth);
  const [height, setHeight] = useState(shownHeight);
  const [dpi, setDpi] = useState(String(spec.dpi));
  const [touched, setTouched] = useState({ width: false, height: false });
  const [invalid, setInvalid] = useState({ width: false, height: false });
  const [tooLarge, setTooLarge] = useState(false);
  const widthMm = touched.width ? parseSizeMm(width) : spec.widthMm;
  const heightMm = touched.height ? parseSizeMm(height) : spec.heightMm;
  const preset = widthMm === null || heightMm === null ? null : presetOf(widthMm, heightMm);

  const choosePreset = (key: string) => {
    // «Свой размер» leaves the fields as they are, to be typed over.
    const chosen = SIZE_PRESETS.find((each) => each.key === key);
    if (chosen === undefined) return;
    setWidth(MM.format(chosen.widthMm));
    setHeight(MM.format(chosen.heightMm));
    setTouched({ width: true, height: true });
    setInvalid({ width: false, height: false });
    setTooLarge(false);
  };

  // `FormDialog` waits on a promise; resizing is immediate.
  const submit = () => {
    setTooLarge(false);
    setInvalid({ width: widthMm === null, height: heightMm === null });
    if (widthMm === null || heightMm === null) return Promise.resolve();
    const next = resizedSpec({ ...spec, dpi: toDpi(dpi) }, widthMm, heightMm, purpose);
    if (next === null) setTooLarge(true);
    else onResize(next);
    return Promise.resolve();
  };

  return (
    <FormDialog
      title={t("office.templateEditor.sizeDialog.title")}
      submitLabel={t("office.templateEditor.sizeDialog.submit")}
      onSubmit={submit}
      onClose={onClose}
      alert={
        tooLarge ? (
          <Alert tone="error">{t("office.templateEditor.sizeDialog.tooLarge")}</Alert>
        ) : undefined
      }
    >
      <Select
        label={t("office.templateEditor.sizeDialog.preset")}
        options={[
          ...SIZE_PRESETS.map((each) => ({
            value: each.key,
            label: t("office.templates.size", {
              width: MM.format(each.widthMm),
              height: MM.format(each.heightMm),
            }),
          })),
          { value: "custom", label: t("office.templateEditor.sizeDialog.custom") },
        ]}
        value={preset ?? "custom"}
        onValueChange={choosePreset}
      />
      <div className="template-size">
        <Input
          label={t("office.templateEditor.sizeDialog.width")}
          inputMode="decimal"
          mono
          value={width}
          onChange={(event) => {
            setWidth(event.target.value);
            setTouched((current) => ({ ...current, width: true }));
            setInvalid((current) => ({ ...current, width: false }));
            setTooLarge(false);
          }}
          {...errorProp(invalid.width ? t("office.templateEditor.sizeDialog.invalid") : undefined)}
        />
        <Input
          label={t("office.templateEditor.sizeDialog.height")}
          inputMode="decimal"
          mono
          value={height}
          onChange={(event) => {
            setHeight(event.target.value);
            setTouched((current) => ({ ...current, height: true }));
            setInvalid((current) => ({ ...current, height: false }));
            setTooLarge(false);
          }}
          {...errorProp(invalid.height ? t("office.templateEditor.sizeDialog.invalid") : undefined)}
        />
      </div>
      <Select
        label={t("office.templateEditor.sizeDialog.dpi")}
        hint={t("office.templateEditor.sizeDialog.dpiHint")}
        options={DPI_CHOICES.map((value) => ({
          value: String(value),
          label: t("office.templates.dpi", { dpi: value }),
        }))}
        value={dpi}
        onValueChange={setDpi}
      />
    </FormDialog>
  );
}
