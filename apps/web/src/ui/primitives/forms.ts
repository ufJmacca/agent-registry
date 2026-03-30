import { escapeHtml } from "../document.js";

import { joinClassNames, renderAttributes, type PrimitiveAttributes } from "./_shared.js";
import { renderSectionFrame } from "./renderers.js";

interface FormFieldOptions {
  fieldClassName?: string;
  inputMarkup: string;
  label: string;
  supportingText?: string;
}

interface FormSectionOptions {
  attributes?: PrimitiveAttributes;
  body: string;
  className?: string;
  description?: string;
  eyebrow: string;
  headerClassName?: string;
  headerContent?: string;
  title: string;
}

export function renderFormField(options: FormFieldOptions): string {
  return `<label${renderAttributes({
    class: joinClassNames("form-field", options.fieldClassName),
  })}>
    <span class="shell-eyebrow">${escapeHtml(options.label)}</span>
    ${options.inputMarkup}
    ${
      options.supportingText === undefined
        ? ""
        : `<span class="form-field__support">${escapeHtml(options.supportingText)}</span>`
    }
  </label>`;
}

export function renderFormSection(options: FormSectionOptions): string {
  return renderSectionFrame({
    as: "section",
    attributes: options.attributes,
    body: options.body,
    className: joinClassNames("form-section", options.className),
    description: options.description,
    eyebrow: options.eyebrow,
    headerClassName: options.headerClassName,
    headerContent: options.headerContent,
    title: options.title,
  });
}
