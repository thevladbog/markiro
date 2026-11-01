import type { ScanSource } from "../../floor/scan-source.js";

/** A global read must never consume a form field, dialog or an unsaved edit. */
export function officeScanBlocked(
  root: Document = document,
  ownedDialog?: Element | null,
): boolean {
  const active = root.activeElement;
  if (
    !ownedDialog?.contains(active) &&
    active?.closest(
      "input, textarea, select, form, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=combobox]",
    )
  )
    return true;
  return [
    ...root.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ),
  ].some((dialog) => {
    if (dialog === ownedDialog) return false;
    const style = root.defaultView?.getComputedStyle(dialog);
    return (
      dialog.closest("[hidden], [inert]") === null &&
      style?.display !== "none" &&
      style?.visibility !== "hidden"
    );
  });
}

export function listenOfficeScans(
  source: ScanSource,
  onScan: (raw: string) => void,
  blocked: () => boolean = () => false,
  root: Document = document,
): () => void {
  let manual: boolean | undefined;
  let stopped = false;
  const held = () => blocked() || officeScanBlocked(root);
  const sync = () => {
    if (stopped) return;
    // Form/modal ownership is observable. Dirty state may clear without a DOM
    // event, so check it at delivery rather than leaving a COM source muted.
    const next = officeScanBlocked(root);
    if (next === manual) return;
    manual = next;
    source.setManualTextEntryActive(next);
    source.clearPendingInput();
  };
  const afterFocus = () => queueMicrotask(sync);
  root.addEventListener("focusin", sync, true);
  root.addEventListener("focusout", afterFocus, true);
  root.addEventListener("keydown", sync, true);
  const observer = new MutationObserver(sync);
  observer.observe(root.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "aria-modal", "data-state"],
  });
  sync();
  const stop = source.start((raw) => {
    if (!stopped && !held()) onScan(raw);
  });
  return () => {
    stopped = true;
    stop();
    observer.disconnect();
    root.removeEventListener("focusin", sync, true);
    root.removeEventListener("focusout", afterFocus, true);
    root.removeEventListener("keydown", sync, true);
    source.clearPendingInput();
    source.setManualTextEntryActive(false);
  };
}
