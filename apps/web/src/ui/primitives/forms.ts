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

interface FormSubpanelOptions {
  attributes?: PrimitiveAttributes;
  body: string;
  className?: string;
  description?: string;
  eyebrow: string;
  headerClassName?: string;
  headerContent?: string;
  title: string;
}

interface FormActionFooterOptions {
  actionMarkup: string;
  attributes?: PrimitiveAttributes;
  className?: string;
  copyClassName?: string;
  description: string;
  eyebrow: string;
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

export function renderFormSubpanel(options: FormSubpanelOptions): string {
  return renderSectionFrame({
    as: "section",
    attributes: options.attributes,
    body: options.body,
    className: joinClassNames("form-subpanel", options.className),
    description: options.description,
    eyebrow: options.eyebrow,
    headerClassName: options.headerClassName,
    headerContent: options.headerContent,
    title: options.title,
    titleTag: "h3",
  });
}

export function renderFormActionFooter(options: FormActionFooterOptions): string {
  return `<section${renderAttributes({
    class: joinClassNames("form-panel", "form-action-footer", options.className),
    ...options.attributes,
  })}>
    <div${renderAttributes({
      class: joinClassNames("form-action-footer__copy", options.copyClassName),
    })}>
      <span class="shell-eyebrow">${escapeHtml(options.eyebrow)}</span>
      <h2>${escapeHtml(options.title)}</h2>
      <p>${escapeHtml(options.description)}</p>
    </div>
    ${options.actionMarkup}
  </section>`;
}
