import { escapeHtml } from "../document.js";
import {
  renderEmptyState,
  renderFormField,
  renderFormSection,
  renderPill,
} from "../primitives/index.js";

interface DraftRegistrationEnvironment {
  environmentKey: string;
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
      ${renderFormField({
        fieldClassName: "draft-field",
        inputMarkup: `<input name="publication:${environmentKey}:healthEndpointUrl" placeholder="https://${environmentKey}.health.example.com/status" />`,
        label: "Health Endpoint URL",
        supportingText: "Required when this environment publication is enabled.",
      })}
      ${renderFormField({
        fieldClassName: "draft-field",
        inputMarkup: `<input name="publication:${environmentKey}:invocationEndpoint" placeholder="https://${environmentKey}.invoke.example.com" />`,
        label: "Optional Invocation Endpoint Override",
        supportingText: "Leave blank to keep the endpoint declared in the raw card.",
      })}
      ${renderFormField({
        fieldClassName: "draft-field draft-field--wide",
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
    : renderEmptyState({
        body: "At least one configured environment is required before a draft can be created.",
        className: "draft-empty-state",
        eyebrow: "Environment Publications",
        meta: "The page keeps the current draft route and multipart form semantics, but it does not invent disabled publication controls when the tenant has no environments.",
        title: "No environments are configured yet for this tenant.",
      });

  return `<section class="hero card stack page-hero draft-page-hero">
    <span class="shell-eyebrow">Draft Registration</span>
    <h1>New Draft Registration</h1>
    <p class="meta">Create one immutable version snapshot with truthful shared metadata and environment-specific publication payloads.</p>
    <p>Every current field name, upload input, and server-rendered POST target stays intact while the page adopts the technical curator grouping from the approved reference.</p>
  </section>
  <form class="draft-form stack" action="/tenants/${encodeURIComponent(options.tenantId)}/drafts" method="post" enctype="multipart/form-data">
    <section class="draft-grid">
      ${renderFormSection({
        attributes: {
          "data-form-region": "metadata",
        },
        body: `<div class="draft-metadata-grid">
          ${renderFormField({
            fieldClassName: "draft-field",
            inputMarkup: `<input name="versionLabel" placeholder="v1" />`,
            label: "Version Label",
          })}
          ${renderFormField({
            fieldClassName: "draft-field",
            inputMarkup: `<input name="displayName" placeholder="Case Resolver" />`,
            label: "Display Name",
          })}
          ${renderFormField({
            fieldClassName: "draft-field draft-field--wide",
            inputMarkup:
              '<textarea name="summary" rows="5" placeholder="Handles support case routing."></textarea>',
            label: "Summary",
          })}
          ${renderFormField({
            fieldClassName: "draft-field draft-field--wide",
            inputMarkup:
              '<textarea name="capabilities" rows="4" placeholder="shared-capability, case-routing"></textarea>',
            label: "Capabilities",
            supportingText: "Comma-separated or newline-delimited values are preserved by the current parser.",
          })}
          ${renderFormField({
            fieldClassName: "draft-field",
            inputMarkup: '<textarea name="tags" rows="3" placeholder="shared-tag, routing"></textarea>',
            label: "Tags",
          })}
          ${renderFormField({
            fieldClassName: "draft-field",
            inputMarkup:
              '<textarea name="requiredRoles" rows="3" placeholder="support-agent"></textarea>',
            label: "Required Roles",
          })}
          ${renderFormField({
            fieldClassName: "draft-field",
            inputMarkup:
              '<textarea name="requiredScopes" rows="3" placeholder="tickets.read, tickets.write"></textarea>',
            label: "Required Scopes",
          })}
        </div>`,
        className: "draft-section card stack",
        description:
          "Shared agent identity, summary, and capability requirements captured once for the full draft.",
        eyebrow: "General Metadata",
        headerClassName: "draft-section__header",
        headerContent: `<div class="draft-pill-row" aria-hidden="true">
          ${renderPill("Version")}
          ${renderPill("Identity")}
          ${renderPill("Requirements")}
        </div>`,
        title: "General Metadata",
      })}
      ${renderFormSection({
        attributes: {
          "data-form-region": "contracts",
        },
        body: `<div class="draft-contract-grid">
          ${renderFormField({
            fieldClassName: "draft-field",
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
          ${renderFormField({
            fieldClassName: "draft-field",
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
        </div>`,
        className: "draft-section card stack",
        description:
          "Header and context contract JSON is validated server-side and applied to every publication in the created draft.",
        eyebrow: "Shared Contracts",
        headerClassName: "draft-section__header",
        headerContent: `<div class="draft-pill-row" aria-hidden="true">
          ${renderPill("JSON")}
          ${renderPill("Shared")}
        </div>`,
        title: "Shared Contracts",
      })}
    </section>
    ${renderFormSection({
      attributes: {
        "data-form-region": "publications",
        "data-visual-dynamic": "publication-sections",
      },
      body: `<div class="draft-publication-stack">
        ${publicationMarkup}
      </div>`,
      className: "draft-section card stack",
      description:
        "Each tenant environment gets its own technical panel so publication metadata stays scannable without changing any field names.",
      eyebrow: "Environment Publications",
      headerClassName: "draft-section__header",
      headerContent: `<div class="draft-pill-row" aria-hidden="true">
        ${renderPill(`${String(options.environments.length)} configured`)}
        ${renderPill("Multipart")}
      </div>`,
      title: "Environment Publications",
    })}
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
