import type { ReactNode } from "react";
import { Section } from "react-email";
import { emailStyles } from "./layout.js";

/** One labelled row of a summary table; the hidden `<br>` keeps rows apart in plain text. */
export function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row" style={emailStyles.summaryLabel}>
        {label + ": "}
      </th>
      <td style={emailStyles.summaryValue}>
        {children}
        <span style={{ display: "none" }}>
          <br />
        </span>
      </td>
    </tr>
  );
}

export function SummaryTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Section aria-label={label} style={emailStyles.summary}>
      <table cellPadding="0" cellSpacing="0" style={emailStyles.summaryTable}>
        <tbody>{children}</tbody>
      </table>
    </Section>
  );
}

export interface LandingLeadUtmProps {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

/** `yandex / cpc / spring` — the non-empty UTM parts in a stable order, or `null`. */
export function formatUtm(utm: LandingLeadUtmProps | undefined): string | null {
  if (utm === undefined) return null;
  const parts = [utm.source, utm.medium, utm.campaign, utm.content, utm.term].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? null : parts.join(" / ");
}

export function formatUtcInstant(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    [pad(value.getUTCDate()), pad(value.getUTCMonth() + 1), value.getUTCFullYear()].join(".") +
    `, ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())} UTC`
  );
}

/** `2026-10-21` → `21.10.2026`. */
export function formatCivilDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day ?? ""}.${month ?? ""}.${year ?? ""}`;
}

const LINES_RU: Record<string, string> = {
  "1": "1 линия",
  "2-3": "2–3 линии",
  "4+": "4 и более линий",
};

export function formatLinesBucket(value: string | undefined): string | null {
  if (value === undefined) return null;
  return LINES_RU[value] ?? value;
}
