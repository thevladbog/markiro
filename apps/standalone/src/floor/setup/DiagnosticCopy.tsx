import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

/**
 * The line a refused print gives for whoever helps (beta 3.2, «Копия диагностики»): what the
 * driver reported against what the sheet needs, numbers only, and a button that copies it.
 * The copy never throws: a webview that refuses the clipboard leaves the line on the screen to
 * be read out.
 */
export function DiagnosticCopy({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // A new line is not yet copied.
  useEffect(() => setCopied(false), [text]);
  return (
    <div className="setup-diagnostic">
      <p className="setup-diagnostic__title">{t("floor.setup.printers.diagnostic.title")}</p>
      <code className="setup-diagnostic__text" data-testid="print-diagnostic">
        {text}
      </code>
      <Button
        size="floor"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {t(
          copied
            ? "floor.setup.printers.diagnostic.copied"
            : "floor.setup.printers.diagnostic.copy",
        )}
      </Button>
    </div>
  );
}
