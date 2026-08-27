import type { AnchorHTMLAttributes, ReactNode } from "react";

export const STATION_STABLE_DOWNLOAD_URL = "https://releases.markiro.app/station/download";

interface StationDownloadLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  children: ReactNode;
}

export function StationDownloadLink({ children, style, ...props }: StationDownloadLinkProps) {
  return (
    <a
      {...props}
      href={STATION_STABLE_DOWNLOAD_URL}
      className="mk-btn mk-btn--secondary mk-btn--md"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "var(--control-md)",
        padding: "0 16px",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--r-2)",
        background: "var(--surface-card)",
        color: "var(--fg-1)",
        font: "600 14px/1 var(--font-ui)",
        textDecoration: "none",
        ...style,
      }}
    >
      {children}
    </a>
  );
}
