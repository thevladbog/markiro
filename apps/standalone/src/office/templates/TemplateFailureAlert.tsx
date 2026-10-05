import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import type { ProductGroup } from "../../host/protocol.js";
import { WriteFailureAlert } from "../page-state.js";
import { describeDefaultConflict, type TemplateFailure } from "./template-text.js";

export interface TemplateFailureAlertProps {
  /** `null` shows nothing. */
  failure: TemplateFailure | null;
  /** The ЧЗ product groups, to name a category; `undefined` names it by its code. */
  groups: readonly ProductGroup[] | undefined;
  /** Loads the templates again after a stale write. */
  onReload: () => void;
}

/**
 * A refused template write above its form: a template that is a default says
 * whose default it is and where to choose another; a stale write offers to
 * reload; anything else is explained by its code (`WriteFailureAlert`).
 */
export function TemplateFailureAlert({ failure, groups, onReload }: TemplateFailureAlertProps) {
  const { t } = useTranslation();
  if (failure?.kind === "default") {
    return <Alert tone="error">{describeDefaultConflict(failure.conflict, groups, t)}</Alert>;
  }
  return <WriteFailureAlert failure={failure} onReload={onReload} />;
}
