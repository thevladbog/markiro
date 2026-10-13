import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from "react";
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
  CategoryPalletSheetDefault,
  CategoryTemplateDefault,
  LabelTemplateSummary,
  PalletSheets,
  ProductGroup,
  TemplateDefaults,
  TemplateDefaultsUpdate,
} from "../../host/protocol.js";
import { templateDefaultsUpdate } from "../../host/requests.js";
import { errorProp } from "../../lib/form-error.js";
import { useCan } from "../access.js";
import { searchableSelect } from "../select-search.js";
import {
  usePalletSheets,
  useProductGroups,
  useTemplateDefaults,
  useTemplates,
} from "../catalog-queries.js";
import type { AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { sheetChoices } from "../sheet-choice.js";
import { templateOptions } from "../template-options.js";
import { CategoryDefaultDialog } from "./CategoryDefaultDialog.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  ORG_DEFAULTS,
  ORG_SHEET_FIELD,
  sameDraft,
  sheetSlotKey,
  slotKey,
  withCategoryDefault,
  withOrgDefault,
  withOrgSheet,
  withoutCategoryDefault,
  withoutSheetCategoryDefault,
  withSheetCategoryDefault,
  type DefaultKind,
  type OrgDefaultField,
} from "./defaults-form.js";
import { groupName, PURPOSE_TONE } from "./template-text.js";

/** Category names in Russian order, with numbers by value. */
const NAMES = new Intl.Collator("ru", { numeric: true });

/** The order of a category's rows: the A4 sheet right after the pallet label, its alternative. */
const KIND_ORDER: readonly DefaultKind[] = ["box", "pallet", "pallet_sheet", "product_duplicate"];

/** A row of the category defaults: a label template's, or the pallet's A4 sheet. */
type CategoryRow =
  | { kind: "label"; key: string; code: number; order: number; entry: CategoryTemplateDefault }
  | { kind: "sheet"; key: string; code: number; order: number; entry: CategoryPalletSheetDefault };

/**
 * «Шаблоны по умолчанию» (spec §4.3, §5.5; renamed from «Умолчания шаблонов»
 * after the beta feedback): one document, the organization's default of each
 * purpose and every category's, and the A4 sheets chosen by default beside the
 * pallet labels (the organization's and each category's), read whenever the
 * page opens and saved whole with the loaded revision. Both office roles
 * change it.
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
  const sheets = usePalletSheets();
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
      {sheets.isError && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void sheets.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templateDefaults.sheetsFailed")}
        </Alert>
      )}
      {/* A new revision — after a save or a reload — starts the form afresh. */}
      <TemplateDefaultsForm
        key={defaults.data.rev}
        document={defaults.data}
        templates={templates}
        groups={groups}
        sheets={sheets}
        onSaved={(saved) => {
          queryClient.setQueryData(officeKeys.templateDefaults, saved);
          // The sheets' list names the organization's sheet too.
          void queryClient.invalidateQueries({ queryKey: officeKeys.palletSheets });
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
  /** The A4 sheets, read by the page as the templates are. */
  sheets: UseQueryResult<PalletSheets, Error>;
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
  sheets,
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
  const currentSheets = useRef(draft.sheetCategories);
  const ids = useId();
  const orgId = (field: OrgDefaultField | typeof ORG_SHEET_FIELD) => `${ids}-org-${field}`;
  const rowId = (key: string) => `${ids}-row-${key}`;
  const removeId = (key: string) => `${ids}-remove-${key}`;
  const addId = `${ids}-add`;
  // Where focus goes once the page has been drawn again: a removed row's button
  // leaves the page, and a refused control is to be read.
  const focusAfterRender = useRef<string | null>(null);
  // The page's own order is the order sent; the table sorts what it shows.
  const rows: CategoryRow[] = [
    ...draft.categories.map((entry): CategoryRow => ({
      kind: "label",
      key: slotKey(entry),
      code: entry.chzProductGroupCode,
      order: KIND_ORDER.indexOf(entry.purpose),
      entry,
    })),
    ...draft.sheetCategories.map((entry): CategoryRow => ({
      kind: "sheet",
      key: sheetSlotKey(entry),
      code: entry.chzProductGroupCode,
      order: KIND_ORDER.indexOf("pallet_sheet"),
      entry,
    })),
  ].sort(
    (a, b) =>
      NAMES.compare(groupName(groups.data, a.code, t), groupName(groups.data, b.code, t)) ||
      a.order - b.order,
  );
  const sheetsReady = sheets.isSuccess;

  useEffect(() => {
    currentCategories.current = draft.categories;
    currentSheets.current = draft.sheetCategories;
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

  const chooseOrgSheet = (id: string) => {
    setDraft((current) => withOrgSheet(current, id));
    if (fieldError?.key === ORG_SHEET_FIELD) setFieldError(null);
  };

  const chooseCategory = (entry: CategoryTemplateDefault) => {
    setDraft((current) => withCategoryDefault(current, entry));
    if (fieldError?.key === slotKey(entry)) setFieldError(null);
  };

  const chooseSheetCategory = (entry: CategoryPalletSheetDefault) => {
    setDraft((current) => withSheetCategoryDefault(current, entry));
    if (fieldError?.key === sheetSlotKey(entry)) setFieldError(null);
  };

  const removeRow = (row: CategoryRow) => {
    // The next row's «Убрать», else the previous row's, else the card's button.
    const at = rows.findIndex((each) => each.key === row.key);
    const neighbour = rows[at + 1] ?? rows[at - 1];
    focusAfterRender.current = neighbour === undefined ? addId : removeId(neighbour.key);
    setDraft((current) =>
      row.kind === "label"
        ? withoutCategoryDefault(current, row.key)
        : withoutSheetCategoryDefault(current, row.code),
    );
    if (fieldError?.key === row.key) setFieldError(null);
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
    const sentSheets = draft.sheetCategories;
    let saved: TemplateDefaults;
    try {
      saved = await save.mutateAsync(templateDefaultsUpdate(defaultsInput(draft), document.rev));
    } catch (error) {
      const outcome = defaultsFailure(
        error,
        sent,
        currentCategories.current,
        sentSheets,
        currentSheets.current,
      );
      if (outcome.kind === "field") {
        setFieldError({ key: outcome.key, message: outcome.message });
        const org = ORG_DEFAULTS.find((each) => each.field === outcome.key);
        focusAfterRender.current =
          outcome.key === ORG_SHEET_FIELD
            ? orgId(ORG_SHEET_FIELD)
            : org === undefined
              ? rowId(outcome.key)
              : orgId(org.field);
        // The refused template or sheet is marked in the choices once its list is read again.
        void templates.refetch();
        void sheets.refetch();
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

  const kindText = (row: CategoryRow) =>
    row.kind === "label"
      ? t(`office.templates.purposes.${row.entry.purpose}`)
      : t("office.templateDefaults.sheetKind");
  const named = (row: CategoryRow) => ({
    category: groupName(groups.data, row.code, t),
    purpose: kindText(row),
  });
  const loadedTemplate = (entry: CategoryTemplateDefault) =>
    loaded.categories.find((each) => slotKey(each) === slotKey(entry))?.templateId ?? "";
  const loadedSheet = (entry: CategoryPalletSheetDefault) =>
    loaded.sheetCategories.find((each) => each.chzProductGroupCode === entry.chzProductGroupCode)
      ?.sheetId ?? "";
  // A row's choices need their own list: the templates for a label, the sheets for a sheet.
  const rowReady = (row: CategoryRow) => (row.kind === "label" ? templates.isSuccess : sheetsReady);
  const columns: TableColumn<CategoryRow>[] = [
    {
      key: "category",
      title: t("office.templateDefaults.table.category"),
      wrap: true,
      render: (row) => groupName(groups.data, row.code, t),
    },
    {
      key: "purpose",
      title: t("office.templateDefaults.table.purpose"),
      render: (row) => (
        <Badge tone={row.kind === "label" ? PURPOSE_TONE[row.entry.purpose] : "steel"}>
          {kindText(row)}
        </Badge>
      ),
    },
    {
      key: "template",
      title: t("office.templateDefaults.table.template"),
      render: (row) =>
        row.kind === "label" ? (
          <Select
            {...searchableSelect(t)}
            id={rowId(row.key)}
            aria-label={t("office.templateDefaults.templateNamed", named(row))}
            // A category default always has a template: «Убрать» clears it, not «Не выбран».
            options={templateOptions(
              templates.data,
              row.entry.purpose,
              row.code,
              [loadedTemplate(row.entry), row.entry.templateId],
              t,
            ).filter((option) => option.value !== "")}
            value={row.entry.templateId}
            onValueChange={(id) => chooseCategory({ ...row.entry, templateId: id })}
            disabled={!canEdit || !templates.isSuccess || saving}
            {...errorProp(fieldError?.key === row.key ? t(fieldError.message) : undefined)}
          />
        ) : (
          <Select
            {...searchableSelect(t)}
            id={rowId(row.key)}
            aria-label={t("office.templateDefaults.templateNamed", named(row))}
            options={sheetChoices(
              sheets.data,
              [loadedSheet(row.entry), row.entry.sheetId],
              "",
              t,
            ).filter((option) => option.value !== "")}
            value={row.entry.sheetId}
            onValueChange={(id) => chooseSheetCategory({ ...row.entry, sheetId: id })}
            disabled={!canEdit || !sheetsReady || saving}
            {...errorProp(fieldError?.key === row.key ? t(fieldError.message) : undefined)}
          />
        ),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      title: t("office.templateDefaults.table.actions"),
      render: (row) => (
        <Button
          id={removeId(row.key)}
          variant="secondary"
          size="compact"
          aria-label={t("office.templateDefaults.removeNamed", named(row))}
          onClick={() => removeRow(row)}
          // «Умолчания сейчас не изменить» while the row's list is not there,
          // and not while a save is on its way.
          disabled={!rowReady(row) || saving}
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
              <Fragment key={field}>
                <Select
                  {...searchableSelect(t)}
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
                {/* The pallet's A4 sheet, its alternative, right after the pallet label. */}
                {purpose === "pallet" && (
                  <>
                    <Select
                      {...searchableSelect(t)}
                      id={orgId(ORG_SHEET_FIELD)}
                      label={t(`office.templateDefaults.fields.${ORG_SHEET_FIELD}`)}
                      hint={t("office.templateDefaults.sheetHint")}
                      options={sheetChoices(
                        sheets.data,
                        [loaded.defaultPalletSheetId, draft.defaultPalletSheetId],
                        t("office.sheetChoice.none"),
                        t,
                      )}
                      value={draft.defaultPalletSheetId}
                      onValueChange={chooseOrgSheet}
                      disabled={!canEdit || !sheetsReady || saving}
                      {...errorProp(
                        fieldError?.key === ORG_SHEET_FIELD ? t(fieldError.message) : undefined,
                      )}
                    />
                    <p className="office-note">{t("office.templateDefaults.palletHint")}</p>
                  </>
                )}
              </Fragment>
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
            getRowKey={(row) => row.key}
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
          sheets={sheets.data}
          taken={draft.categories}
          takenSheets={draft.sheetCategories}
          onClose={() => setAdding(false)}
          onAdd={(added) => {
            if (added.kind === "label") chooseCategory(added.entry);
            else chooseSheetCategory(added.entry);
            setAdding(false);
          }}
        />
      )}
    </>
  );
}
