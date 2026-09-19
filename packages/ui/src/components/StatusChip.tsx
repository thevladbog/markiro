import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * Тег фазы. Глиф и тон выводятся из фазы жизненного цикла и только из неё:
 * до этого глиф читался из тона (`ok` всегда давал `✓`), а тон назначался
 * заново на каждой странице, из-за чего активная смена получала галочку, а
 * отменённый документ — глиф дубликата.
 *
 * Словарь фаз и правило серого — в спеке
 * `docs/superpowers/specs/2026-09-19-tag-semantics-and-geometry-design.md`.
 */
export type TagPhase =
  | "draft"
  | "planned"
  | "active"
  | "running"
  | "done"
  | "attention"
  | "duplicate"
  | "failed"
  | "retired"
  | "dismantled"
  | "none";

/** Кабинет, цех и настенный планшет читают с разного расстояния. */
export type TagSize = "office" | "floor" | "wall";

type PhaseTone = "neutral" | "ok" | "done" | "warn" | "error" | "info";

interface PhaseConfig {
  glyph: string;
  tone: PhaseTone;
}

/**
 * `failed` и `retired` делят глиф `✕` намеренно: форма исхода у них одна —
 * терминальный отрицательный результат, а различается срочность, и её несёт
 * тон. Серый допустим только здесь: draft, retired, dismantled, none.
 */
const PHASE: Record<TagPhase, PhaseConfig> = {
  draft: { glyph: "✎", tone: "neutral" },
  planned: { glyph: "◷", tone: "info" },
  active: { glyph: "▸", tone: "ok" },
  running: { glyph: "⟳", tone: "info" },
  done: { glyph: "✓", tone: "done" },
  attention: { glyph: "!", tone: "warn" },
  duplicate: { glyph: "⧉", tone: "warn" },
  failed: { glyph: "✕", tone: "error" },
  retired: { glyph: "✕", tone: "neutral" },
  dismantled: { glyph: "⊘", tone: "neutral" },
  none: { glyph: "·", tone: "neutral" },
};

export const PHASE_GLYPH: Record<TagPhase, string> = Object.fromEntries(
  Object.entries(PHASE).map(([phase, config]) => [phase, config.glyph]),
) as Record<TagPhase, string>;

export const PHASE_TONE: Record<TagPhase, PhaseTone> = Object.fromEntries(
  Object.entries(PHASE).map(([phase, config]) => [phase, config.tone]),
) as Record<TagPhase, PhaseTone>;

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  phase: TagPhase;
  /**
   * Подпись обязательна: тег без слова читается только по цвету, а цвет не
   * может быть единственным носителем смысла. Переводом занимается вызывающая
   * сторона — компонент не знает про i18n.
   */
  label: ReactNode;
  size?: TagSize;
  /**
   * Разрешить длинной подписи перенос. Фаза не ограничивает длину `label` —
   * вызывающая сторона может дать длинное предложение фактом жизненного
   * цикла (например «Состав изменился после закрытия»), и в узкой колонке
   * nowrap-тег так же отдаёт всю строку в min-content контейнера, как и у
   * `Badge`. Перенос — вопрос вёрстки, а не семантики фазы, поэтому признак
   * включается явно и не завязан на конкретную фазу.
   */
  wrap?: boolean;
}

export function StatusChip({
  phase,
  label,
  size = "office",
  wrap = false,
  className,
  ...rest
}: StatusChipProps) {
  const config = PHASE[phase];

  return (
    <span
      className={cn(
        "mk-tag",
        `mk-tag--${size}`,
        `mk-tag--${config.tone}`,
        wrap && "mk-tag--wrap",
        "mk-chip",
        `mk-chip--${phase}`,
        className,
      )}
      {...rest}
    >
      <span className="mk-tag__glyph" aria-hidden="true">
        {config.glyph}
      </span>
      <span>{label}</span>
    </span>
  );
}
