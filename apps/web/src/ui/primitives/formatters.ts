export function formatConsoleState(value: string): string {
  return value
    .split(/[_-]/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatConsoleTimestamp(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  const timestamp = value instanceof Date ? value.toISOString() : new Date(value).toISOString();

  return timestamp.replace(".000Z", "Z");
}
