import {
  formatInstallerSize,
  formatReleaseDate,
  hashCommand,
  type StandaloneRelease,
} from "../lib/release";

/**
 * /skachat/: fills the release facts from `latest.json` and, once the form is
 * accepted, swaps the form for «Ссылка готова» (or «Версия готовится» when no
 * release is published or the pointer cannot be read).
 */

export interface DownloadPageRuntime {
  readonly fetchRelease: () => Promise<StandaloneRelease | null>;
  readonly copy: (text: string) => Promise<void>;
}

function fill(root: ParentNode, field: string, text: string): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-release="${field}"]`)) {
    element.textContent = text;
  }
}

export function showReleaseFacts(root: ParentNode, release: StandaloneRelease): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-release-fact]")) {
    element.hidden = false;
  }
  fill(root, "version", release.version);
  fill(root, "date", formatReleaseDate(release.releasedAt));
  fill(root, "size", formatInstallerSize(release.sizeBytes));
  fill(root, "file", release.fileName);
  fill(root, "sha256", release.sha256);
  fill(root, "command", hashCommand(release.fileName));
  for (const link of root.querySelectorAll<HTMLAnchorElement>("[data-release-link]")) {
    link.href = release.installerUrl;
  }
  for (const button of root.querySelectorAll<HTMLElement>('[data-copy="link"]')) {
    button.dataset.copyText = release.installerUrl;
  }
  for (const button of root.querySelectorAll<HTMLElement>('[data-copy="sha256"]')) {
    button.dataset.copyText = release.sha256;
  }
  for (const button of root.querySelectorAll<HTMLElement>('[data-copy="command"]')) {
    button.dataset.copyText = hashCommand(release.fileName);
  }
}

export function showAccepted(
  root: Document,
  email: string,
  release: StandaloneRelease | null,
): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-ready-email]")) {
    element.textContent = email;
  }
  if (release !== null) showReleaseFacts(root, release);
  for (const element of root.querySelectorAll<HTMLElement>("[data-download-start]")) {
    element.hidden = true;
  }
  const ready = root.querySelector<HTMLElement>("[data-download-ready]");
  if (ready !== null) {
    ready.hidden = false;
    ready.dataset.release = release === null ? "pending" : "ready";
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-release-only]")) {
    element.hidden = release === null;
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-pending-only]")) {
    element.hidden = release !== null;
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-download-after]")) {
    element.hidden = false;
  }
  const heading = ready?.querySelector<HTMLElement>(
    release === null
      ? "[data-pending-only] [data-ready-heading]"
      : "[data-release-only] [data-ready-heading]",
  );
  heading?.focus();
  root.defaultView?.scrollTo({ top: 0 });
}

export function initDownloadPage(
  root: Document,
  runtime: DownloadPageRuntime,
): {
  /** Starts reading `latest.json`; the page calls it when the visitor turns to the form. */
  readonly prefetch: () => void;
  readonly accept: (email: string) => Promise<void>;
  readonly dispose: () => void;
} {
  // Nothing is fetched at page load: the release bucket is a third party, so the page
  // asks it only once the visitor starts on the form.
  let release: Promise<StandaloneRelease | null> | null = null;
  const load = (): Promise<StandaloneRelease | null> => {
    if (release === null) {
      const pending = runtime.fetchRelease();
      release = pending;
      void pending.then((value) => {
        if (value !== null) showReleaseFacts(root, value);
      });
    }
    return release;
  };

  const onClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("[data-copy]");
    const text = button?.dataset.copyText;
    if (button === null || button === undefined || text === undefined) return;
    void runtime.copy(text).then(
      () => {
        const status = root.querySelector<HTMLElement>("[data-copy-status]");
        if (status !== null) status.textContent = button.dataset.copiedLabel ?? "Скопировано";
        button.dataset.copied = "";
      },
      () => undefined,
    );
  };
  root.addEventListener("click", onClick);

  return {
    prefetch: () => {
      void load();
    },
    accept: async (email) => {
      let value = await load();
      if (value === null) {
        // A failed read gets one more chance before the visitor sees «готовится».
        release = null;
        value = await load();
      }
      showAccepted(root, email, value);
    },
    dispose: () => root.removeEventListener("click", onClick),
  };
}
