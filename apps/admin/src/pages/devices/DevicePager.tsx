import { Button } from "@markiro/ui";

export function DevicePager({
  page,
  pageSize,
  total,
  onPage,
  label,
  previousLabel,
  nextLabel,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  label: string;
  previousLabel: string;
  nextLabel: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label={label}
      style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}
    >
      <Button
        aria-label={previousLabel}
        size="compact"
        variant="secondary"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </Button>
      <span style={{ font: "var(--text-meta)", color: "var(--fg-2)" }}>
        {page} / {pageCount}
      </span>
      <Button
        aria-label={nextLabel}
        size="compact"
        variant="secondary"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        ›
      </Button>
    </nav>
  );
}
