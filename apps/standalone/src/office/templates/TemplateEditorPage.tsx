import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import { Alert, Button, PageHeader } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { scopeOf } from "./category-scope.js";
import { readSpec, startingSpec } from "./editor-model.js";
import { TemplateEditor } from "./TemplateEditor.js";

/**
 * «Новый шаблон» (`/templates/new`): an enabled box template for every
 * category with an empty 58×40 label, and no name until one is typed or a
 * JSON import brings one.
 */
export function NewTemplatePage() {
  const { t } = useTranslation();
  return (
    <TemplateEditor
      title={t("office.templateEditor.newTitle")}
      template={null}
      opened={{
        name: "",
        purpose: "box",
        enabled: true,
        scope: { mode: "all", codes: [] },
        spec: startingSpec("box"),
      }}
    />
  );
}

/** A page that cannot show the editor: why, and the way back to the list. */
function EditorUnavailable({ title, message }: { title: string; message: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
      <Alert tone="warn">{message}</Alert>
    </>
  );
}

/**
 * A template opened for a change (`/templates/:id`): read with its layout
 * whenever the page opens, and shown only once read on this visit, so the
 * revision a save sends is the one on screen. A stock template keeps its
 * name and layout, a layout the domain cannot read is not shown, and a
 * template deleted elsewhere is said to be gone. After a stale save the
 * template is read again and the editor starts afresh with it (`key`).
 */
export function EditTemplatePage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const template = useOfficeQuery(officeKeys.template(id), (api, token) =>
    api.getTemplate(token, id),
  );
  const title = t("office.templateEditor.editTitle");

  if (template.isError) {
    if (template.error instanceof HostError && template.error.code === "not_found") {
      return <EditorUnavailable title={title} message={t("office.templateEditor.gone")} />;
    }
    return (
      <>
        <PageHeader title={title} />
        <LoadError error={template.error} onRetry={() => void template.refetch()} />
      </>
    );
  }
  if (!template.isFetchedAfterMount || template.data === undefined) return <PageLoading />;
  const opened = template.data;
  if (opened.stock) {
    return <EditorUnavailable title={title} message={t("office.templateEditor.stockLocked")} />;
  }
  const spec = readSpec(opened.spec);
  if (spec === null) {
    return <EditorUnavailable title={title} message={t("office.templateEditor.unreadable")} />;
  }
  return (
    <TemplateEditor
      key={opened.rev}
      title={t("office.templateEditor.namedTitle", { name: opened.name })}
      template={opened}
      opened={{
        name: opened.name,
        purpose: opened.purpose,
        enabled: opened.enabled,
        scope: scopeOf(opened.chzProductGroupCodes),
        spec,
      }}
      onReload={() => void template.refetch()}
    />
  );
}
