/**
 * Opens a print form in a new tab without navigating the current page.
 *
 * The blank tab has to be opened synchronously inside the click handler: after an
 * `await` the browser treats `window.open` as a pop-up and blocks it. Returns
 * `false` when the browser blocked the tab (the URL is then never requested).
 */
export function openDocumentInNewTab(getUrl: () => Promise<string>): boolean {
  const target = window.open("about:blank", "_blank");
  if (!target) return false;
  target.opener = null;
  void getUrl()
    .then((url) => target.location.replace(url))
    .catch(() => target.close());
  return true;
}
