import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, PageHeader, Select } from "@markiro/ui";

import type {
  LabelTemplateSummary,
  TemplateDefaults,
  TemplateDefaultsUpdate,
} from "../../host/protocol.js";
import { templateDefaultsUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useCan } from "../access.js";
import { useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import type { AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { templateOptions } from "../template-options.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  ORG_DEFAULTS,
  sameDraft,
  withOrgDefault,
  type OrgDefaultField,
} from "./defaults-form.js";

/**
 * The templates' defaults (spec §4.3, §5.5): one document, the organization's
 * default of each purpose and every category's, read whenever the page opens
 * and saved whole with the loaded revision. Both office roles change it.
 */
export function TemplateDefaultsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.templateDefaults.title")} />
      <TemplateDefaultsContent />
    </>
  );
}

function TemplateDefaultsContent() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaults = useTemplateDefaults();
  const templates = useTemplates();
  // The revision the last save produced; its notice stays until the document changes.
  const [savedRev, setSavedRev] = useState<number | null>(null);

  if (defaults.isPending) return <PageLoading />;
  if (defaults.isError) {
    return <LoadError error={defaults.error} onRetry={() => void defaults.refetch()} />;
  }

  return (
    <>
      {savedRev === defaults.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {templates.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void templates.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templateDefaults.templatesFailed")}
        </Alert>
      )}
      {/* A new revision — after a save or a reload — starts the form afresh. */}
      <TemplateDefaultsForm
        key={defaults.data.rev}
        document={defaults.data}
        templates={templates}
        onSaved={(saved) => {
          queryClient.setQueryData(officeKeys.templateDefaults, saved);
          setSavedRev(saved.rev);
        }}
        onSubmitStart={() => setSavedRev(null)}
        onReload={() => void defaults.refetch()}
      />
    </>
  );
}

interface TemplateDefaultsFormProps {
  /** The loaded document: its revision goes with the save. */
  document: TemplateDefaults;
  /**
   * The template list, read once per visit by the page: the form remounts on
   * every new revision, and a query of its own would read the list again each
   * time.
   */
  templates: UseQueryResult<LabelTemplateSummary[], Error>;
  onSaved: (document: TemplateDefaults) => void;
  onSubmitStart: () => void;
  /** The document changed on the host: load it again, which drops the edits. */
  onReload: () => void;
}

/**
 * The document as a form. An organization default offers «Не выбран» and the
 * enabled templates of its purpose for every category (`templateOptions` for
 * category `null`), and keeps a default the list does not offer as a marked
 * choice. Edits stay in the page until «Сохранить», which sends the whole
 * document (`templateDefaultsUpdate`) and drops a second click while the save
 * is on its way; «Отменить изменения» goes back to the loaded document.
 */
function TemplateDefaultsForm({
  document,
  templates,
  onSaved,
  onSubmitStart,
  onReload,
}: TemplateDefaultsFormProps) {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const loaded = draftOf(document);
  const [draft, setDraft] = useState(loaded);
  const [fieldError, setFieldError] = useState<{ key: string; message: string } | null>(null);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const save = useOfficeMutation((api, token, body: TemplateDefaultsUpdate) =>
    api.updateTemplateDefaults(token, body),
  );
  const dirty = !sameDraft(draft, loaded);

  const chooseOrg = (field: OrgDefaultField, id: string) => {
    setDraft((current) => withOrgDefault(current, field, id));
    if (fieldError?.key === field) setFieldError(null);
  };

  const cancel = () => {
    setDraft(loaded);
    setFieldError(null);
    setFailure(null);
  };

  const submit = async () => {
    onSubmitStart();
    setFailure(null);
    setFieldError(null);
    let saved: TemplateDefaults;
    try {
      saved = await save.mutateAsync(templateDefaultsUpdate(defaultsInput(draft), document.rev));
    } catch (error) {
      const outcome = defaultsFailure(error);
      if (outcome.kind === "field") {
        setFieldError({ key: outcome.key, message: outcome.message });
        // The refused template is marked in the choices once the list is read again.
        void templates.refetch();
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
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

  return (
    <form className="standalone-form" onSubmit={send} noValidate>
      <WriteFailureAlert
        failure={failure}
        onReload={onReload}
        staleMessage="office.templateDefaults.stale"
      />
      <Card title={t("office.templateDefaults.organization")} titleAs="h2">
        <div className="standalone-form">
          {ORG_DEFAULTS.map(({ field, purpose }) => (
            <Select
              key={field}
              native
              label={t(`office.templateDefaults.fields.${field}`)}
              hint={t("office.templateDefaults.orgHint")}
              options={templateOptions(
                templates.data,
                purpose,
                null,
                [loaded[field], draft[field]],
                t,
              )}
              value={draft[field]}
              onValueChange={(id) => chooseOrg(field, id)}
              disabled={!canEdit || !templates.isSuccess}
              {...errorProp(fieldError?.key === field ? t(fieldError.message) : undefined)}
            />
          ))}
        </div>
      </Card>
      {canEdit && (
        <div className="standalone-form__actions">
          <p className="office-note" aria-live="polite">
            {dirty ? t("office.templateDefaults.dirty") : ""}
          </p>
          <Button variant="secondary" onClick={cancel} disabled={!dirty || saving}>
            {t("office.templateDefaults.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={!dirty}>
            {t("office.common.save")}
          </Button>
        </div>
      )}
    </form>
  );
}
