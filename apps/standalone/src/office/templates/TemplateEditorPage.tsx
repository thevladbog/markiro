import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import type { LabelTemplateSpec } from "@markiro/domain";
import { Alert, Button, PageHeader } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { LabelTemplate } from "../../host/protocol.js";
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
      layoutFollowsPurpose
    />
  );
}

/** A page that cannot show the editor: why, a copy where one helps, and the way back. */
function EditorUnavailable({
  title,
  message,
  copyOf,
}: {
  title: string;
  message: string;
  /** The template to offer a copy of. */
  copyOf?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            {copyOf !== undefined && (
              <Button
                variant="secondary"
                onClick={() => void navigate(`/templates/${copyOf}/copy`)}
              >
                {t("office.templateEditor.copy")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void navigate("/templates")}>
              {t("office.templateEditor.back")}
            </Button>
          </>
        }
      />
      <Alert tone="warn">{message}</Alert>
    </>
  );
}

/**
 * The template a page opens (`/templates/:id`, `/templates/:id/copy`), read
 * with its layout whenever the page opens and passed on only once read on
 * this visit, so a save works on what is on screen. A template deleted
 * elsewhere is said to be gone and a layout the domain cannot read is not
 * shown; `render` gets the template, its layout and a way to read it again.
 */
function OpenedTemplate({
  title,
  render,
}: {
  title: string;
  render: (template: LabelTemplate, spec: LabelTemplateSpec, reload: () => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const template = useOfficeQuery(officeKeys.template(id), (api, token) =>
    api.getTemplate(token, id),
  );
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
  const spec = readSpec(template.data.spec);
  if (spec === null) {
    return <EditorUnavailable title={title} message={t("office.templateEditor.unreadable")} />;
  }
  return render(template.data, spec, () => void template.refetch());
}

/**
 * A template opened for a change (`/templates/:id`). A stock template keeps
 * its name and layout, so it offers a copy instead. After a stale save the
 * template is read again and the editor starts afresh with it (`key`).
 */
export function EditTemplatePage() {
  const { t } = useTranslation();
  const title = t("office.templateEditor.editTitle");
  return (
    <OpenedTemplate
      title={title}
      render={(template, spec, reload) =>
        template.stock ? (
          <EditorUnavailable
            title={title}
            message={t("office.templateEditor.stockLocked")}
            copyOf={template.id}
          />
        ) : (
          <TemplateEditor
            key={template.rev}
            title={t("office.templateEditor.namedTitle", { name: template.name })}
            template={template}
            opened={{
              name: template.name,
              purpose: template.purpose,
              enabled: template.enabled,
              scope: scopeOf(template.chzProductGroupCodes),
              spec,
            }}
            onReload={reload}
          />
        )
      }
    />
  );
}

/**
 * A copy of a template (`/templates/:id/copy`), stock ones included: a new
 * template with the source's purpose, flag, categories and layout under
 * «<name> — копия», saved as an ordinary create. The purpose may change and
 * the layout stays.
 */
export function CopyTemplatePage() {
  const { t } = useTranslation();
  return (
    <OpenedTemplate
      title={t("office.templateEditor.copyTitle")}
      render={(source, spec) => (
        <TemplateEditor
          title={t("office.templateEditor.copyNamedTitle", { name: source.name })}
          template={null}
          opened={{
            name: t("office.templateEditor.copyName", { name: source.name }),
            purpose: source.purpose,
            enabled: source.enabled,
            scope: scopeOf(source.chzProductGroupCodes),
            spec,
          }}
        />
      )}
    />
  );
}
