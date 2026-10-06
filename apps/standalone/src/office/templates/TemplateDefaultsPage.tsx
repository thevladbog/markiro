import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
  Select,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type {
  CategoryTemplateDefault,
  LabelTemplateSummary,
  ProductGroup,
  TemplateDefaults,
  TemplateDefaultsUpdate,
} from "../../host/protocol.js";
import { templateDefaultsUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useCan } from "../access.js";
import { useProductGroups, useTemplateDefaults, useTemplates } from "../catalog-queries.js";
import type { AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { templateOptions } from "../template-options.js";
import { CategoryDefaultDialog } from "./CategoryDefaultDialog.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  ORG_DEFAULTS,
  sameDraft,
  slotKey,
  withCategoryDefault,
  withOrgDefault,
  withoutCategoryDefault,
  type OrgDefaultField,
} from "./defaults-form.js";
import { groupName, PURPOSE_TONE, PURPOSES } from "./template-text.js";

/** Category names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

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
  const groups = useProductGroups();
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
      {groups.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templateDefaults.groupsFailed")}
        </Alert>
      )}
      {/* A new revision — after a save or a reload — starts the form afresh. */}
      <TemplateDefaultsForm
        key={defaults.data.rev}
        document={defaults.data}
        templates={templates}
        groups={groups}
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
  /** The ЧЗ product groups, read by the page as the templates are. */
  groups: UseQueryResult<ProductGroup[], Error>;
  onSaved: (document: TemplateDefaults) => void;
  onSubmitStart: () => void;
  /** The document changed on the host: load it again, which drops the edits. */
  onReload: () => void;
}

/**
 * The document as a form. An organization default offers «Не выбран» and the
 * enabled templates of its purpose for every category (`templateOptions` for
 * category `null`), and keeps a default the list does not offer as a marked
 * choice. The category defaults are rows by category name, each a choice of
 * the templates that fit its category and purpose, removed with «Убрать» and
 * added in `CategoryDefaultDialog`. Edits stay in the page until «Сохранить»,
 * which sends the whole document (`templateDefaultsUpdate`) and drops a second
 * click while the save is on its way; «Отменить изменения» goes back to the
 * loaded document.
 */
function TemplateDefaultsForm({
  document,
  templates,
  groups,
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
  const [adding, setAdding] = useState(false);
  // Set at once, so a second submit in the same moment is dropped before
  // `saving` has re-rendered the button.
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const save = useOfficeMutation((api, token, body: TemplateDefaultsUpdate) =>
    api.updateTemplateDefaults(token, body),
  );
  const dirty = !sameDraft(draft, loaded);
  // The draft as it is now, for a refusal that arrives after the click that sent it.
  const currentCategories = useRef(draft.categories);
  const ids = useId();
  const orgId = (field: OrgDefaultField) => `${ids}-org-${field}`;
  const rowId = (key: string) => `${ids}-row-${key}`;
  const removeId = (key: string) => `${ids}-remove-${key}`;
  const addId = `${ids}-add`;
  // Where focus goes once the page has been drawn again: a removed row's button
  // leaves the page, and a refused control is to be read.
  const focusAfterRender = useRef<string | null>(null);
  // The page's own order is the order sent; the table sorts what it shows.
  const rows = [...draft.categories].sort(
    (a, b) =>
      NAMES.compare(
        groupName(groups.data, a.chzProductGroupCode, t),
        groupName(groups.data, b.chzProductGroupCode, t),
      ) || PURPOSES.indexOf(a.purpose) - PURPOSES.indexOf(b.purpose),
  );

  useEffect(() => {
    currentCategories.current = draft.categories;
  });
  // After every render, once no save is on its way (the controls are off until
  // then and cannot take focus).
  useEffect(() => {
    const target = focusAfterRender.current;
    if (target === null || saving) return;
    focusAfterRender.current = null;
    // `document` is the page's loaded document here.
    globalThis.document.getElementById(target)?.focus();
  });

  const chooseOrg = (field: OrgDefaultField, id: string) => {
    setDraft((current) => withOrgDefault(current, field, id));
    if (fieldError?.key === field) setFieldError(null);
  };

  const chooseCategory = (entry: CategoryTemplateDefault) => {
    setDraft((current) => withCategoryDefault(current, entry));
    if (fieldError?.key === slotKey(entry)) setFieldError(null);
  };

  const removeCategory = (entry: CategoryTemplateDefault) => {
    // The next row's «Убрать», else the previous row's, else the card's button.
    const at = rows.findIndex((each) => slotKey(each) === slotKey(entry));
    const neighbour = rows[at + 1] ?? rows[at - 1];
    focusAfterRender.current = neighbour === undefined ? addId : removeId(slotKey(neighbour));
    setDraft((current) => withoutCategoryDefault(current, slotKey(entry)));
    if (fieldError?.key === slotKey(entry)) setFieldError(null);
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
    // The host names a category default by its index in what was sent.
    const sent = draft.categories;
    let saved: TemplateDefaults;
    try {
      saved = await save.mutateAsync(templateDefaultsUpdate(defaultsInput(draft), document.rev));
    } catch (error) {
      const outcome = defaultsFailure(error, sent, currentCategories.current);
      if (outcome.kind === "field") {
        setFieldError({ key: outcome.key, message: outcome.message });
        const org = ORG_DEFAULTS.find((each) => each.field === outcome.key);
        focusAfterRender.current = org === undefined ? rowId(outcome.key) : orgId(org.field);
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

  const named = (entry: CategoryTemplateDefault) => ({
    category: groupName(groups.data, entry.chzProductGroupCode, t),
    purpose: t(`office.templates.purposes.${entry.purpose}`),
  });
  const loadedTemplate = (entry: CategoryTemplateDefault) =>
    loaded.categories.find((each) => slotKey(each) === slotKey(entry))?.templateId ?? "";
  const columns: TableColumn<CategoryTemplateDefault>[] = [
    {
      key: "category",
      title: t("office.templateDefaults.table.category"),
      wrap: true,
      render: (entry) => groupName(groups.data, entry.chzProductGroupCode, t),
    },
    {
      key: "purpose",
      title: t("office.templateDefaults.table.purpose"),
      render: (entry) => (
        <Badge tone={PURPOSE_TONE[entry.purpose]}>
          {t(`office.templates.purposes.${entry.purpose}`)}
        </Badge>
      ),
    },
    {
      key: "template",
      title: t("office.templateDefaults.table.template"),
      render: (entry) => (
        <Select
          native
          id={rowId(slotKey(entry))}
          aria-label={t("office.templateDefaults.templateNamed", named(entry))}
          // A category default always has a template: «Убрать» clears it, not «Не выбран».
          options={templateOptions(
            templates.data,
            entry.purpose,
            entry.chzProductGroupCode,
            [loadedTemplate(entry), entry.templateId],
            t,
          ).filter((option) => option.value !== "")}
          value={entry.templateId}
          onValueChange={(id) => chooseCategory({ ...entry, templateId: id })}
          disabled={!canEdit || !templates.isSuccess || saving}
          {...errorProp(fieldError?.key === slotKey(entry) ? t(fieldError.message) : undefined)}
        />
      ),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.templateDefaults.table.actions"),
      render: (entry) => (
        <Button
          id={removeId(slotKey(entry))}
          variant="secondary"
          size="compact"
          aria-label={t("office.templateDefaults.removeNamed", named(entry))}
          onClick={() => removeCategory(entry)}
          // «Умолчания сейчас не изменить» while the list is not there, and not
          // while a save is on its way.
          disabled={!templates.isSuccess || saving}
        >
          {t("office.templateDefaults.remove")}
        </Button>
      ),
    });
  }

  return (
    <>
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
                id={orgId(field)}
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
                disabled={!canEdit || !templates.isSuccess || saving}
                {...errorProp(fieldError?.key === field ? t(fieldError.message) : undefined)}
              />
            ))}
          </div>
        </Card>
        <Card
          title={t("office.templateDefaults.categories")}
          titleAs="h2"
          {...(canEdit
            ? {
                actions: (
                  <Button
                    id={addId}
                    variant="secondary"
                    size="compact"
                    onClick={() => setAdding(true)}
                    disabled={!groups.isSuccess || !templates.isSuccess || saving}
                  >
                    {t("office.templateDefaults.add")}
                  </Button>
                ),
              }
            : {})}
        >
          <p className="office-note">{t("office.templateDefaults.categoriesHint")}</p>
          <Table
            columns={columns}
            rows={rows}
            getRowKey={slotKey}
            empty={t("office.templateDefaults.empty")}
            scrollLabel={t("office.templateDefaults.categories")}
          />
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
      {/* Outside the page's form: a dialog has a form of its own. */}
      {canEdit && adding && groups.isSuccess && templates.isSuccess && (
        <CategoryDefaultDialog
          groups={groups.data}
          templates={templates.data}
          taken={draft.categories}
          onClose={() => setAdding(false)}
          onAdd={(entry) => {
            chooseCategory(entry);
            setAdding(false);
          }}
        />
      )}
    </>
  );
}
