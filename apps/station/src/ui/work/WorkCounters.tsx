export interface WorkCountersProps {
  accepted: number;
  rejected: number;
  pendingSync: number;
  locale?: string;
  labels: {
    accepted: string;
    rejected: string;
    synchronized: string;
    pending?: (count: number) => string;
  };
}

export function WorkCounters({
  accepted,
  rejected,
  pendingSync,
  locale = "en-US",
  labels,
}: WorkCountersProps) {
  const pendingLabel = labels.pending?.(pendingSync) ?? `${pendingSync} pending`;
  return (
    <section
      className="work-instrument work-counters"
      aria-label={`${labels.accepted}, ${labels.rejected}`}
    >
      <dl>
        <div>
          <dt>{labels.accepted}</dt>
          <dd>{accepted.toLocaleString(locale)}</dd>
        </div>
        <div>
          <dt>{labels.rejected}</dt>
          <dd>{rejected.toLocaleString(locale)}</dd>
        </div>
      </dl>
      <p className="work-counters__sync" data-tone={pendingSync > 0 ? "warn" : "ok"}>
        {pendingSync > 0 ? pendingLabel : labels.synchronized}
      </p>
    </section>
  );
}
