/**
 * Puts `text` on the clipboard: the async API first, then the old
 * `execCommand("copy")` on a temporary field (a webview that withholds the
 * clipboard from a page still lets a click select and copy). `false` when
 * neither worked; the text stays on screen for the person to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based copy.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
