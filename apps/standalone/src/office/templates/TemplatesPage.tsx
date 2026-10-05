import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { useProductGroups, useTemplates } from "../catalog-queries.js";
import { LoadError, PageLoading } from "../page-state.js";
import {
  findTemplates,
  templatesByName,
  type TemplatePurposeFilter,
  type TemplateStateFilter,
} from "./template-list.js";
import { describeScope, dpiText, PURPOSE_TONE, PURPOSES, sizeText } from "./template-text.js";

const PURPOSE_FILTERS: readonly TemplatePurposeFilter[] = ["all", ...PURPOSES];
const STATE_FILTERS: readonly TemplateStateFilter[] = ["all", "enabled", "disabled"];

/**
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4). The host sends the whole
 * list, so the search and the filters work here, and the page sorts what it
 * shows by name. A product group's name comes from the host's lookup; when it
 * does not load, the list stays and shows the codes.
 */
export function TemplatesPage() {
  const { t } = useTranslation();
  const templates = useTemplates();
  const groups = useProductGroups();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<TemplatePurposeFilter>("all");
  const [state, setState] = useState<TemplateStateFilter>("all");

  const columns: TableColumn<LabelTemplateSummary>[] = [
    {
      key: "name",
      title: t("office.templates.table.name"),
      wrap: true,
      render: (template) => (
        <span className="template-name">
          <span>{template.name}</span>
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
      key: "dpi",
      title: t("office.templates.table.dpi"),
      mono: true,
      render: (template) => dpiText(template.dpi, t),
    },
    {
      key: "scope",
      title: t("office.templates.table.scope"),
      wrap: true,
      render: (template) => {
        const scope = describeScope(template.chzProductGroupCodes, groups.data, t);
        return <span title={scope.title ?? undefined}>{scope.label}</span>;
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

  const content = () => {
    if (templates.isPending) return <PageLoading />;
    if (templates.isError) {
      return (
        <LoadError
          error={templates.error}
          onRetry={() => {
            void templates.refetch();
            // One click recovers both reads when the group names failed too.
            if (groups.isError) void groups.refetch();
          }}
        />
      );
    }
    const found = findTemplates(templatesByName(templates.data), search, purpose, state);
    return (
      <>
        <FilterBar
          label={t("office.templates.filters")}
          resultSummary={t("office.templates.found", {
            shown: found.length,
            total: templates.data.length,
          })}
        >
          <Input
            label={t("office.templates.search")}
            hint={t("office.templates.searchHint")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            native
            label={t("office.templates.purposeFilter")}
            options={PURPOSE_FILTERS.map((value) => ({
              value,
              label: t(`office.templates.purposes.${value}`),
            }))}
            value={purpose}
            onValueChange={setPurpose}
          />
          <Select
            native
            label={t("office.templates.stateFilter")}
            options={STATE_FILTERS.map((value) => ({
              value,
              label: t(`office.templates.stateFilters.${value}`),
            }))}
            value={state}
            onValueChange={setState}
          />
        </FilterBar>
        <Card>
          <Table
            columns={columns}
            rows={found}
            getRowKey={(template) => template.id}
            empty={t(
              templates.data.length === 0
                ? "office.templates.empty"
                : "office.templates.nothingFound",
            )}
            scrollLabel={t("office.templates.title")}
          />
        </Card>
      </>
    );
  };

  return (
    <>
      <PageHeader title={t("office.templates.title")} />
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
      {content()}
    </>
  );
}
