export function formatRussianMinutes(value: number): string {
  const absolute = Math.abs(value);
  const lastTwo = absolute % 100;
  const last = absolute % 10;
  const unit =
    lastTwo >= 11 && lastTwo <= 14
      ? "минут"
      : last === 1
        ? "минуту"
        : last >= 2 && last <= 4
          ? "минуты"
          : "минут";
  return `${value} ${unit}`;
}
