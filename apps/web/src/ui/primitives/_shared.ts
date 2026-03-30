import { escapeHtml } from "../document.js";

export type PrimitiveAttributeValue = boolean | number | string | null | undefined;

export type PrimitiveAttributes = Record<string, PrimitiveAttributeValue>;

export function joinClassNames(
  ...values: Array<false | null | string | undefined>
): string | undefined {
  const className = values.filter((value): value is string => value !== undefined && value !== null && value !== "").join(" ");

  return className === "" ? undefined : className;
}

export function renderAttributes(attributes: PrimitiveAttributes = {}): string {
  const renderedAttributes = Object.entries(attributes)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null || value === false) {
        return [];
      }

      if (value === true) {
        return [` ${key}`];
      }

      return [` ${key}="${escapeHtml(String(value))}"`];
    })
    .join("");

  return renderedAttributes;
}
