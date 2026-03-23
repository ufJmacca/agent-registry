import { escapeHtml } from "../document.js";

interface DraftRegistrationEnvironment {
  environmentKey: string;
}

function renderMetadataField(options: {
  fieldClassName?: string;
  fieldName: string;
  inputMarkup: string;
  label: string;
  supportingText?: string;
}): string {
  return `<label class="draft-field${options.fieldClassName ? ` ${options.fieldClassName}` : ""}">
    <span class="shell-eyebrow">${escapeHtml(options.label)}</span>
    ${options.inputMarkup}
    ${
      options.supportingText === undefined
        ? ""
        : `<span class="draft-field__support">${escapeHtml(options.supportingText)}</span>`
    }
  </label>`;
}

function renderPublicationSection(environment: DraftRegistrationEnvironment): string {
  const environmentKey = escapeHtml(environment.environmentKey);

  return `<section class="draft-publication-card stack" data-publication-environment="${environmentKey}">
    <div class="draft-publication-header">
      <div class="stack">
        <span class="shell-eyebrow">Environment Publication</span>
        <h3>${environmentKey}</h3>
        <p class="meta">Each environment keeps its own enablement flag, health probe, invocation override, and raw card file.</p>
      </div>
      <label class="draft-toggle">
        <input type="checkbox" name="publication:${environmentKey}:enabled" />
        <span>Include publication</span>
      </label>
    </div>
    <div class="draft-publication-grid">
      ${renderMetadataField({
        fieldName: `publication:${environmentKey}:healthEndpointUrl`,
        inputMarkup: `<input name="publication:${environmentKey}:healthEndpointUrl" placeholder="https://${environmentKey}.health.example.com/status" />`,
        label: "Health Endpoint URL",
        supportingText: "Required when this environment publication is enabled.",
      })}
      ${renderMetadataField({
        fieldName: `publication:${environmentKey}:invocationEndpoint`,
        inputMarkup: `<input name="publication:${environmentKey}:invocationEndpoint" placeholder="https://${environmentKey}.invoke.example.com" />`,
        label: "Optional Invocation Endpoint Override",
        supportingText: "Leave blank to keep the endpoint declared in the raw card.",
      })}
      ${renderMetadataField({
        fieldClassName: "draft-field--wide",
        fieldName: `publication:${environmentKey}:rawCard`,
        inputMarkup: `<input type="file" name="publication:${environmentKey}:rawCard" />`,
        label: "Raw Card Upload",
        supportingText: "Uploaded as multipart form data and validated against the current raw-card rules.",
      })}
    </div>
  </section>`;
}

export function renderDraftRegistrationPage(options: {
  environments: DraftRegistrationEnvironment[];
  tenantId: string;
}): string {
  const hasEnvironments = options.environments.length > 0;
  const publicationMarkup = hasEnvironments
    ? options.environments.map((environment) => renderPublicationSection(environment)).join("")
    : `<div class="draft-empty-state stack">
        <span class="shell-eyebrow">Environment Publications</span>
        <h3>No environments are configured yet for this tenant.</h3>
        <p>At least one configured environment is required before a draft can be created.</p>
        <p class="meta">The page keeps the current draft route and multipart form semantics, but it does not invent disabled publication controls when the tenant has no environments.</p>
      </div>`;

  return `<section class="hero card stack page-hero draft-page-hero">
    <span class="shell-eyebrow">Draft Registration</span>
    <h1>New Draft Registration</h1>
    <p class="meta">Create one immutable version snapshot with truthful shared metadata and environment-specific publication payloads.</p>
    <p>Every current field name, upload input, and server-rendered POST target stays intact while the page adopts the technical curator grouping from the approved reference.</p>
  </section>
  <form class="draft-form stack" action="/tenants/${encodeURIComponent(options.tenantId)}/drafts" method="post" enctype="multipart/form-data">
    <section class="draft-grid">
      <section class="draft-section card stack" data-form-region="metadata">
        <div class="draft-section__header">
          <div class="stack">
            <span class="shell-eyebrow">General Metadata</span>
            <h2>General Metadata</h2>
            <p class="meta">Shared agent identity, summary, and capability requirements captured once for the full draft.</p>
          </div>
          <div class="draft-pill-row" aria-hidden="true">
            <span class="pill">Version</span>
            <span class="pill">Identity</span>
            <span class="pill">Requirements</span>
          </div>
        </div>
        <div class="draft-metadata-grid">
          ${renderMetadataField({
            fieldName: "versionLabel",
            inputMarkup: `<input name="versionLabel" placeholder="v1" />`,
            label: "Version Label",
          })}
          ${renderMetadataField({
            fieldName: "displayName",
            inputMarkup: `<input name="displayName" placeholder="Case Resolver" />`,
            label: "Display Name",
          })}
          ${renderMetadataField({
            fieldClassName: "draft-field--wide",
            fieldName: "summary",
            inputMarkup:
              '<textarea name="summary" rows="5" placeholder="Handles support case routing."></textarea>',
            label: "Summary",
          })}
          ${renderMetadataField({
            fieldClassName: "draft-field--wide",
            fieldName: "capabilities",
            inputMarkup:
              '<textarea name="capabilities" rows="4" placeholder="shared-capability, case-routing"></textarea>',
            label: "Capabilities",
            supportingText: "Comma-separated or newline-delimited values are preserved by the current parser.",
          })}
          ${renderMetadataField({
            fieldName: "tags",
            inputMarkup: '<textarea name="tags" rows="3" placeholder="shared-tag, routing"></textarea>',
            label: "Tags",
          })}
          ${renderMetadataField({
            fieldName: "requiredRoles",
            inputMarkup:
              '<textarea name="requiredRoles" rows="3" placeholder="support-agent"></textarea>',
            label: "Required Roles",
          })}
          ${renderMetadataField({
            fieldName: "requiredScopes",
            inputMarkup:
              '<textarea name="requiredScopes" rows="3" placeholder="tickets.read, tickets.write"></textarea>',
            label: "Required Scopes",
          })}
        </div>
      </section>
      <section class="draft-section card stack" data-form-region="contracts">
        <div class="draft-section__header">
          <div class="stack">
            <span class="shell-eyebrow">Shared Contracts</span>
            <h2>Shared Contracts</h2>
            <p class="meta">Header and context contract JSON is validated server-side and applied to every publication in the created draft.</p>
          </div>
          <div class="draft-pill-row" aria-hidden="true">
            <span class="pill">JSON</span>
            <span class="pill">Shared</span>
          </div>
        </div>
        <div class="draft-contract-grid">
          ${renderMetadataField({
            fieldName: "headerContract",
            inputMarkup: `<textarea name="headerContract" rows="12">[
  {
    "name": "X-User-Id",
    "required": true,
    "source": "user.id",
    "description": "Identifies the calling user."
  }
]</textarea>`,
            label: "Header Contract JSON",
            supportingText: "Malformed JSON still returns the current 400 field-level validation error.",
          })}
          ${renderMetadataField({
            fieldName: "contextContract",
            inputMarkup: `<textarea name="contextContract" rows="12">[
  {
    "key": "client_id",
    "required": true,
    "type": "string",
    "description": "Selects the client partition.",
    "example": "client-123"
  }
]</textarea>`,
            label: "Context Contract JSON",
            supportingText: "Required context keys are enforced exactly as they are in the current backend flow.",
          })}
        </div>
      </section>
    </section>
    <section class="draft-section card stack" data-form-region="publications" data-visual-dynamic="publication-sections">
      <div class="draft-section__header">
        <div class="stack">
          <span class="shell-eyebrow">Environment Publications</span>
          <h2>Environment Publications</h2>
          <p class="meta">Each tenant environment gets its own technical panel so publication metadata stays scannable without changing any field names.</p>
        </div>
        <div class="draft-pill-row" aria-hidden="true">
          <span class="pill">${String(options.environments.length)} configured</span>
          <span class="pill">Multipart</span>
        </div>
      </div>
      <div class="draft-publication-stack">
        ${publicationMarkup}
      </div>
    </section>
    <section class="draft-action-footer card" data-form-region="actions">
      <div class="draft-action-copy">
        <span class="shell-eyebrow">Draft Actions</span>
        <h2>Draft Actions</h2>
        <p>Create the draft now, then use the existing version-detail route to inspect it and submit it for review.</p>
      </div>
      <button class="draft-action-button" type="submit"${hasEnvironments ? "" : " disabled"}>Create Draft</button>
    </section>
  </form>`;
}
