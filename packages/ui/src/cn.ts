export function cn(...args: Array<string | false | null | undefined>): string {
  return args.filter((arg) => typeof arg === "string" && arg.length > 0).join(" ");
}
