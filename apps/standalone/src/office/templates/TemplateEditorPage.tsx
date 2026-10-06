import { useTranslation } from "react-i18next";

import { startingSpec } from "./editor-model.js";
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
