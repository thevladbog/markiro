import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";

import {
  Alert,
  Badge,
  Button,
  Input,
  PageHeader,
  Select,
  StatusChip,
  VisuallyHidden,
  type TableColumn,
} from "@markiro/ui";

import { listViewState } from "../list/list-state.js";
import { ListCard, ListFilters } from "../list/ListCard.js";
import { ListEmpty, ListError, ListNothing, ListSkeleton } from "../list/ListStates.js";
import { RowActionBar } from "../list/RowActionBar.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { PagedTable } from "../paging/PagedTable.js";
import type { LabelTemplate, LabelTemplateSummary } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useProductGroups, useTemplates } from "../catalog-queries.js";
import { officeKeys } from "../office-query.js";
import { useChangeList } from "../records.js";
import { TemplateTabPanel, TemplateTabsBar } from "./TemplatesSection.js";
import { TemplateCategoriesDialog } from "./TemplateCategoriesDialog.js";
import { TemplateStateDialog } from "./TemplateStateDialog.js";
import { TemplateThumb } from "./TemplateThumb.js";
import {
  findTemplates,
  templatesByName,
  withTemplateChange,
  type TemplatePurposeFilter,
  type TemplateStateFilter,
} from "./template-list.js";
import { describeScope, PURPOSE_TONE, PURPOSES, sizeText } from "./template-text.js";

const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

type TemplatesDialog = { kind: "state" | "categories"; template: LabelTemplateSummary };

/** What the editor leaves in the location when it comes back after a save. */
const EDITOR_RETURN = z.object({ notice: z.string() });

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards, with
 * a thumbnail beside each name (`TemplateThumb`). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes. Both office roles switch
 * templates on and off and change their categories (`editCatalog`); a write's
 * answer goes into the cached row in place (`withTemplateChange`), and the
 * list is not read again. «Создать шаблон», «Изменить» and «Копировать» open
 * the editor, which comes back here with a notice after a save or a delete.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
  const canEdit = useCan("editCatalog");
  const templates = useTemplates();
  const groups = useProductGroups();
  const changeList = useChangeList<LabelTemplateSummary>(officeKeys.templates);
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");
  const [dialog, setDialog] = useState<TemplatesDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const back = EDITOR_RETURN.safeParse(location.state);
    return back.success ? back.data.notice : null;
  });

  const open = (next: TemplatesDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (template: LabelTemplate, message: string) => {
    changeList((list) => withTemplateChange(list, template));
    setDialog(null);
    setNotice(message);
  };
  const reload = () => {
    setDialog(null);
    void templates.refetch();
  };
  // A template deleted elsewhere leaves the list; the dialog stays and says why.
  const missing = () => void templates.refetch();

  const columns: TableColumn<LabelTemplateSummary>[] = [
    {
      key: "name",
      title: t("office.templates.table.name"),
      wrap: true,
      minWidth: 220,
      render: (template) => (
        <span className="template-name">
          <TemplateThumb template={template} />
          <span className="template-name__text">{template.name}</span>
          {template.stock && <Badge tone="steel">{t("office.templates.stock")}</Badge>}
        </span>
      ),
    },
    {
      key: "purpose",
      title: t("office.templates.table.purpose"),
      render: (template) => (
        <Badge tone={PURPOSE_TONE[template.purpose]}>
          {t(`office.templates.purposes.${template.purpose}`)}
        </Badge>
      ),
    },
    {
      key: "size",
      title: t("office.templates.table.size"),
      mono: true,
      render: (template) => sizeText(template, t),
    },
    {
      key: "scope",
      title: t("office.templates.table.scope"),
      wrap: true,
      minWidth: 180,
      render: (template) => {
        const scope = describeScope(template.chzProductGroupCodes, groups.data, t);
        return (
          <>
            <span title={scope.title ?? undefined}>{scope.label}</span>
            {/* A count's names, for whoever cannot hover the title (a screen reader);
                an empty list has no names to read. */}
            {scope.title !== null && scope.title !== "" && scope.title !== scope.label && (
              <VisuallyHidden>
                {t("office.templates.scope.listed", { names: scope.title })}
              </VisuallyHidden>
            )}
          </>
        );
      },
    },
    {
      key: "state",
      title: t("office.templates.table.state"),
      render: (template) => (
        <StatusChip
          phase={template.enabled ? "active" : "retired"}
          label={t(
            template.enabled
              ? "office.templates.states.enabled"
              : "office.templates.states.disabled",
          )}
        />
      ),
    },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      stickyEnd: true,
      title: t("office.templates.table.actions"),
      render: (template) => (
        <RowActionBar
          actions={[
            // A stock template keeps its name and layout (the host refuses a change): it is copied.
            template.stock
              ? {
                  key: "copy",
                  label: t("office.templates.copyNamed", { name: template.name }),
                  icon: "copy",
                  onSelect: () => void navigate(`/templates/${template.id}/copy`),
                }
              : {
                  key: "edit",
                  label: t("office.templates.editNamed", { name: template.name }),
                  icon: "pencil",
                  onSelect: () => void navigate(`/templates/${template.id}`),
                },
          ]}
          menu={{
            label: t("office.common.rowActions", { name: template.name }),
            items: [
              {
                key: "categories",
                label: t("office.templates.categories"),
                ariaLabel: t("office.templates.categoriesNamed", { name: template.name }),
                icon: "tag",
                onSelect: () => open({ kind: "categories", template }),
              },
              {
                key: "state",
                label: t(template.enabled ? "office.templates.disable" : "office.templates.enable"),
                ariaLabel: t(
                  template.enabled
                    ? "office.templates.disableNamed"
                    : "office.templates.enableNamed",
                  { name: template.name },
                ),
                icon: template.enabled ? "stop" : "reset",
                destructive: template.enabled,
                onSelect: () => open({ kind: "state", template }),
              },
            ],
          }}
        />
      ),
    });
  }

  const found = templates.isSuccess
    ? findTemplates(templatesByName(templates.data), search, purpose, state)
    : [];
  const filtersOn = search !== "" || purpose !== "all" || state !== "all";
  const resetFilters = () => {
    setSearch("");
    setPurpose("all");
    setState("all");
  };
  const view = listViewState({
    pending: templates.isPending,
    failed: templates.isError,
    total: templates.data?.length ?? 0,
    found: found.length,
  });
  const emptyState =
    view === "loading" ? (
      <ListSkeleton />
    ) : view === "error" ? (
      <ListError
        error={templates.error}
        onRetry={() => {
          void templates.refetch();
          // One click recovers both reads when the group names failed too.
          if (groups.isError) void groups.refetch();
        }}
      />
    ) : view === "empty" ? (
      <ListEmpty
        icon="tag"
        title={t("office.templates.empty")}
        {...(canEdit
          ? {
              action: (
                <Button
                  icon={<OfficeIcon name="plus" size={20} />}
                  onClick={() => void navigate("/templates/new")}
                >
                  {t("office.templates.create")}
                </Button>
              ),
            }
          : {})}
      />
    ) : view === "nothing" ? (
      <ListNothing title={t("office.templates.nothingFound")} onReset={resetFilters} />
    ) : null;
  const content = (
    <ListCard>
      {templates.isSuccess && (
        <ListFilters
          label={t("office.templates.filters")}
          resultSummary={t("office.templates.found", {
            shown: found.length,
            total: templates.data.length,
          })}
          onReset={filtersOn ? resetFilters : undefined}
        >
          <Input
            label={t("office.templates.search")}
            placeholder={t("office.templates.searchHint")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label={t("office.templates.purposeFilter")}
            options={PURPOSE_FILTERS.map((value) => ({
              value,
              label: t(`office.templates.purposes.${value}`),
            }))}
            value={purpose}
            onValueChange={setPurpose}
          />
          <Select
            label={t("office.templates.stateFilter")}
            options={STATE_FILTERS.map((value) => ({
              value,
              label: t(`office.templates.stateFilters.${value}`),
            }))}
            value={state}
            onValueChange={setState}
          />
        </ListFilters>
      )}
      <PagedTable
        tableId="templates"
        resetKey={`${search}|${purpose}|${state}`}
        columns={columns}
        rows={found}
        getRowKey={(template) => template.id}
        empty={emptyState}
        scrollLabel={t("office.templates.title")}
      />
    </ListCard>
  );

  return (
    <>
      <PageHeader
        title={t("office.templates.title")}
        description={t("office.templates.subtitle")}
        actions={
          canEdit ? (
            <Button onClick={() => void navigate("/templates/new")}>
              {t("office.templates.create")}
            </Button>
          ) : undefined
        }
      />
      <TemplateTabsBar />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {/* About the categories column: with no list on screen the templates' error stands alone. */}
      {groups.isError && templates.isSuccess && (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" size="compact" onClick={() => void groups.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {t("office.templates.groupsFailed")}
        </Alert>
      )}
      <TemplateTabPanel>{content}</TemplateTabPanel>
      {canEdit && dialog?.kind === "state" && (
        <TemplateStateDialog
          template={dialog.template}
          onClose={() => setDialog(null)}
          onSaved={(template) =>
            saved(
              template,
              t(
                template.enabled
                  ? "office.templates.enabledNotice"
                  : "office.templates.disabledNotice",
                { name: template.name },
              ),
            )
          }
          onReload={reload}
          onMissing={missing}
        />
      )}
      {canEdit && dialog?.kind === "categories" && (
        <TemplateCategoriesDialog
          template={dialog.template}
          onClose={() => setDialog(null)}
          onSaved={(template) =>
            saved(template, t("office.templates.categoriesNotice", { name: template.name }))
          }
          onReload={reload}
          onMissing={missing}
        />
      )}
    </>
  );
}
