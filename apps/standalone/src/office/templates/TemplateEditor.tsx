import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Alert, Button, Card, Checkbox, Input, PageHeader, Select } from "@markiro/ui";

import type {
  LabelTemplate,
  TemplateCreate,
  TemplatePurpose,
  TemplateUpdate,
} from "../../host/protocol.js";
import { templateCreate, templateUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useProductGroups } from "../catalog-queries.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { scopeCodes } from "./category-scope.js";
import { CategoryScopeField } from "./CategoryScopeField.js";
import { downloadFile } from "./download.js";
import { editorFailure, type EditorFailure, type EditorField } from "./editor-failure.js";
import {
  checkedSpec,
  draftChanged,
  duplicateLayoutInvalid,
  egaisOutsideScope,
  startingSpec,
  templateFileName,
  templateJson,
  templateNameRule,
  type TemplateDraft,
} from "./editor-model.js";
import type { ImportAnalysis } from "./import-analysis.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { LabelSizeDialog } from "./LabelSizeDialog.js";
import { TemplateFailureAlert } from "./TemplateFailureAlert.js";
import { dpiText, PURPOSES, sizeText } from "./template-text.js";

export interface TemplateEditorProps {
  /** The page's heading. */
  title: string;
  /**
   * The template being changed, as it was read when the page opened: its
   * revision goes with the save. `null` for a new template.
   */
  template: LabelTemplate | null;
  /** What the editor opens with; a save sends the draft made of it. */
  opened: TemplateDraft;
  /** Reads the template again after a stale save; the editor then starts afresh. */
  onReload?: () => void;
}

/**
 * A label template's editor (spec §5.5), after the cloud's
 * `LabelEditorPage`: the name, the purpose, the flag, the categories
 * (`CategoryScopeField`, with the cloud's EGAIS hint) and the layout, which
 * only an import puts on the label (`ImportCodeDialog`); a layout downloads
 * as JSON. Nothing goes to the host before «Сохранить»: the name is trimmed
 * (`templateNameRule`), the layout is what `labelTemplateSpecSchema` makes
 * of it (`checkedSpec`), the categories go ascending (`scopeCodes`). A new
 * template is created (`templateCreate`); a template being changed keeps its
 * purpose and sends what differs and its layout with the opened revision
 * (`templateUpdate`), «Сохранить» staying off until something changed. A
 * saved template takes the office back to «Шаблоны» with a notice, and the
 * list, which holds no layouts, is read again.
 */
export function TemplateEditor({ title, template, opened, onReload }: TemplateEditorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const groups = useProductGroups();
  const [draft, setDraft] = useState(opened);
  const [fieldError, setFieldError] = useState<{ field: EditorField; message: string } | null>(
    null,
  );
  const [failure, setFailure] = useState<Exclude<EditorFailure, { kind: "field" }> | null>(null);
  const [importing, setImporting] = useState(false);
  const [sizing, setSizing] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const create = useOfficeMutation((api, token, body: TemplateCreate) =>
    api.createTemplate(token, body),
  );
  const update = useOfficeMutation(
    (api, token, { id, body }: { id: string; body: TemplateUpdate }) =>
      api.updateTemplate(token, id, body),
  );
  const ids = useId();
  const nameId = `${ids}-name`;
  const scopeId = `${ids}-scope`;
  // The refused control, focused once the form is on again after a save.
  const focusAfterRender = useRef<string | null>(null);
  const dirty = draftChanged(opened, draft);
  const duplicateInvalid = duplicateLayoutInvalid(draft.spec, draft.purpose);

  useEffect(() => {
    const target = focusAfterRender.current;
    if (target === null || saving) return;
    focusAfterRender.current = null;
    document.getElementById(target)?.focus();
  });

  const change = (next: Partial<TemplateDraft>, field?: EditorField) => {
    setDraft((current) => ({ ...current, ...next }));
    if (field !== undefined && fieldError?.field === field) setFieldError(null);
  };

  const choosePurpose = (purpose: TemplatePurpose) => {
    setDraft((current) => ({
      ...current,
      purpose,
      // An untouched starting layout follows the purpose; anything imported stays.
      spec:
        JSON.stringify(current.spec) === JSON.stringify(startingSpec(current.purpose))
          ? startingSpec(purpose)
          : current.spec,
    }));
  };

  const replaceLayout = (analysis: ImportAnalysis) => {
    setDraft((current) => ({
      ...current,
      spec: analysis.result.spec,
      // A JSON `{ name, purpose, spec }` names a template that has no name yet.
      name:
        analysis.name !== undefined && current.name.trim() === "" ? analysis.name : current.name,
    }));
    setImporting(false);
  };

  const refuse = (field: EditorField, message: string) => {
    setFieldError({ field, message });
    focusAfterRender.current = field === "name" ? nameId : scopeId;
  };

  const submit = async () => {
    setFailure(null);
    setFieldError(null);
    const name = templateNameRule.safeParse(draft.name);
    if (!name.success) {
      refuse("name", name.error.issues[0]?.message ?? "office.templateEditor.errors.name");
      return;
    }
    const codes = scopeCodes(draft.scope);
    if (codes !== null && codes.length === 0) {
      refuse("scope", "office.categoryScope.empty");
      return;
    }
    const spec = checkedSpec(draft.spec);
    if (spec === null) {
      setFailure({ kind: "alert", message: "office.templateEditor.errors.spec" });
      return;
    }
    let saved: LabelTemplate;
    try {
      saved =
        template === null
          ? await create.mutateAsync(
              templateCreate({
                name: name.data,
                purpose: draft.purpose,
                enabled: draft.enabled,
                chzProductGroupCodes: codes,
                spec,
              }),
            )
          : await update.mutateAsync({
              id: template.id,
              body: templateUpdate(template, {
                name: name.data,
                enabled: draft.enabled,
                chzProductGroupCodes: codes,
                spec,
              }),
            });
    } catch (error) {
      const outcome = editorFailure(error);
      if (outcome.kind === "field") refuse(outcome.field, outcome.message);
      else setFailure(outcome);
      return;
    }
    // The list holds no layouts and is read again; nothing of this template is kept.
    queryClient.removeQueries({ queryKey: officeKeys.templates, exact: true });
    void navigate("/templates", {
      state: {
        notice: t(
          template === null ? "office.templateEditor.created" : "office.templateEditor.saved",
          { name: saved.name },
        ),
      },
    });
  };

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    void submit().finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
  };

  const downloadJson = () =>
    downloadFile(
      new Blob([templateJson(draft.name.trim(), draft.purpose, draft.spec)], {
        type: "application/json",
      }),
      `${templateFileName(draft.name)}.json`,
    );

  const errorOf = (field: EditorField) =>
    errorProp(fieldError?.field === field ? t(fieldError.message) : undefined);

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <Button variant="secondary" onClick={() => void navigate("/templates")}>
            {t("office.templateEditor.back")}
          </Button>
        }
      />
      <form className="standalone-form" onSubmit={send} noValidate>
        <TemplateFailureAlert
          failure={failure}
          groups={groups.data}
          {...(onReload === undefined ? {} : { onReload })}
        />
        {/* Off while a save is on its way: an edit made then would be lost. */}
        <fieldset className="template-editor__fields" disabled={saving}>
          <Card title={t("office.templateEditor.general")} titleAs="h2">
            <div className="standalone-form">
              <Input
                id={nameId}
                label={t("office.templateEditor.name")}
                value={draft.name}
                onChange={(event) => change({ name: event.target.value }, "name")}
                {...errorOf("name")}
              />
              <Select
                native
                label={t("office.templateEditor.purpose")}
                // The host has no way to change a purpose.
                disabled={template !== null}
                {...(template === null ? {} : { hint: t("office.templateEditor.purposeFixed") })}
                options={PURPOSES.map((value) => ({
                  value,
                  label: t(`office.templates.purposes.${value}`),
                }))}
                value={draft.purpose}
                onValueChange={choosePurpose}
              />
              <Checkbox
                label={t("office.templateEditor.enabled")}
                hint={t("office.templateEditor.enabledHint")}
                checked={draft.enabled}
                onCheckedChange={(enabled) => change({ enabled })}
              />
            </div>
          </Card>
          <Card title={t("office.templateEditor.layout")} titleAs="h2">
            <div className="standalone-form">
              <div className="template-editor__size">
                <p>
                  {t("office.templateEditor.sizeValue", {
                    size: sizeText(draft.spec, t),
                    dpi: dpiText(draft.spec.dpi, t),
                  })}
                </p>
                <Button variant="secondary" size="compact" onClick={() => setSizing(true)}>
                  {t("office.templateEditor.changeSize")}
                </Button>
              </div>
              <p>
                {draft.spec.elements.length === 0
                  ? t("office.templateEditor.empty")
                  : t("office.templateEditor.elements", { n: draft.spec.elements.length })}
              </p>
              {duplicateInvalid && (
                <Alert
                  tone="error"
                  action={
                    <Button
                      variant="secondary"
                      size="compact"
                      onClick={() => change({ spec: startingSpec("product_duplicate") })}
                    >
                      {t("office.templateEditor.duplicateReset")}
                    </Button>
                  }
                >
                  {t("office.templateEditor.duplicateInvalid")}
                </Alert>
              )}
              <div className="template-editor__actions">
                <Button variant="secondary" onClick={() => setImporting(true)}>
                  {t("office.templateEditor.import")}
                </Button>
                <Button variant="secondary" onClick={downloadJson}>
                  {t("office.templateEditor.downloadJson")}
                </Button>
              </div>
              <p className="office-note">{t("office.templateEditor.languages")}</p>
            </div>
          </Card>
          <Card title={t("office.templateEditor.categories")} titleAs="h2">
            <div id={scopeId} tabIndex={-1} className="standalone-form">
              <CategoryScopeField
                value={draft.scope}
                onChange={(scope) => change({ scope }, "scope")}
                {...errorOf("scope")}
              />
              {egaisOutsideScope(draft.spec, draft.scope) && (
                <Alert tone="warn">{t("office.templateEditor.egais")}</Alert>
              )}
            </div>
          </Card>
        </fieldset>
        <div className="standalone-form__actions">
          <p className="office-note" aria-live="polite">
            {dirty ? t("office.templateEditor.dirty") : ""}
          </p>
          <Button
            type="submit"
            loading={saving}
            disabled={duplicateInvalid || (template !== null && !dirty)}
          >
            {t("office.common.save")}
          </Button>
        </div>
      </form>
      {/* Outside the page's form: each dialog has a form of its own. */}
      {sizing && (
        <LabelSizeDialog
          spec={draft.spec}
          purpose={draft.purpose}
          onClose={() => setSizing(false)}
          onResize={(spec) => {
            change({ spec });
            setSizing(false);
          }}
        />
      )}
      {importing && (
        <ImportCodeDialog
          purpose={draft.purpose}
          initialFormat={draft.spec.language}
          initialDpi={draft.spec.dpi}
          unsaved={dirty}
          onClose={() => setImporting(false)}
          onReplace={replaceLayout}
        />
      )}
    </>
  );
}
