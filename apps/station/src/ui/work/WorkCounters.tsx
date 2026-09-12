export interface WorkCountersProps {
  accepted: number;
  rejected: number;
  duplicates: number;
  pendingSync: number;
  locale?: string;
  labels: {
    accepted: string;
    errors: string;
    duplicates: string;
    synchronized: string;
    pending?: (count: number) => string;
  };
}

export function WorkCounters({
  accepted,
  rejected,
  duplicates,
  pendingSync,
  locale = "en-US",
  labels,
}: WorkCountersProps) {
  const pendingLabel = labels.pending?.(pendingSync) ?? `${pendingSync} pending`;
  return (
    <section
      className="work-instrument work-counters"
      aria-label={`${labels.accepted}, ${labels.errors}, ${labels.duplicates}`}
    >
      <dl>
        <div>
          <dt>{labels.accepted}</dt>
          <dd>{accepted.toLocaleString(locale)}</dd>
        </div>
        <div>
          <dt>{labels.errors}</dt>
          <dd>{(rejected - duplicates).toLocaleString(locale)}</dd>
        </div>
        <div>
          <dt>{labels.duplicates}</dt>
          <dd>{duplicates.toLocaleString(locale)}</dd>
        </div>
      </dl>
      <p className="work-counters__sync" data-tone={pendingSync > 0 ? "warn" : "ok"}>
        {pendingSync > 0 ? pendingLabel : labels.synchronized}
      </p>
    </section>
  );
}
