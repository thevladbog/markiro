import type { HTMLAttributes } from "react";

import { cn } from "../cn.js";
import type { TagSize } from "./StatusChip.js";

/**
 * Тег категории и счётчика. Глифа не несёт никогда: глиф закреплён за фазой
 * жизненного цикла, и тег категории фазой не является.
 *
 * Категорийные тона равногромкие — среди них нет «лучшего» и нет «мёртвого».
 * До этого двум равноправным режимам смены доставались `neutral` и `accent`,
 * и «Валидация» читалась как архив, а «Агрегация» как успех.
 */
export type BadgeTone =
  "neutral" | "ok" | "warn" | "error" | "info" | "violet" | "teal" | "magenta" | "steel";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: TagSize;
  /** Числа, коды и номера — моноширинно с табличными цифрами. Слова — нет. */
  mono?: boolean;
  /**
   * Разрешить длинной подписи перенос. Признак включается явно, потому что
   * nowrap-тег отдаёт всю свою строку в min-content контейнера, а в узкой
   * колонке таблицы это выталкивает остальные колонки и обрезает сам тег.
   */
  wrap?: boolean;
}

export function Badge({
  tone = "neutral",
  size = "office",
  mono = false,
  wrap = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "mk-tag",
        `mk-tag--${size}`,
        `mk-tag--${tone}`,
        mono && "mk-tag--mono",
        wrap && "mk-tag--wrap",
        "mk-badge",
        `mk-badge--${tone}`,
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
