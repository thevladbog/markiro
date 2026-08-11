import type { ReactNode } from "react";

export function AuthFrame({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <main className="auth-page" id="main-content">
      <section className="auth-panel" aria-label={eyebrow}>
        <header className="auth-panel__header">
          <span className="brand-mark" aria-label="Markiro">
            M
          </span>
          <div>
            <p className="auth-panel__eyebrow">{eyebrow}</p>
            <p className="auth-panel__product">MARKIRO · PLATFORM OPS</p>
          </div>
        </header>
        <div className="auth-panel__body">{children}</div>
        <footer className="auth-panel__rail" aria-hidden="true">
          <span>SECURE CHANNEL</span>
          <span>SAAS · 01</span>
        </footer>
      </section>
    </main>
  );
}
