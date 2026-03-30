import { escapeHtml } from "../document.js";
import {
  renderEmptyState,
  renderFormField,
  renderFormSection,
  renderPill,
  renderRecordList,
  renderSectionFrame,
  renderSidePanel,
  renderStatTile,
} from "../primitives/index.js";

interface EnvironmentManagementPageOptions {
  environmentKeys: string[];
  tenantId: string;
}

function renderEnvironmentEntry(environmentKey: string, index: number): string {
  return `<article class="environment-entry">
    <div class="environment-entry__meta">
      <span class="shell-eyebrow">Environment ${String(index + 1).padStart(2, "0")}</span>
      ${renderPill("Tenant publication target")}
    </div>
    <h3>${escapeHtml(environmentKey)}</h3>
    <p class="meta">Registered for truthful draft publication targeting and tenant operations.</p>
  </article>`;
}

function renderEnvironmentInventory(
  environmentKeys: string[],
): string {
  const emptyStateMarkup =
    environmentKeys.length === 0
      ? renderEmptyState({
          className: "environment-empty",
          eyebrow: "Inventory Status",
          body: "Add an environment to unlock publication targeting for this tenant.",
          title: "No environments have been configured yet.",
        })
      : undefined;

  return renderRecordList({
    attributes: {
      "data-visual-dynamic": "environment-list",
    },
    emptyState: emptyStateMarkup,
    items: environmentKeys.map((environmentKey, index) =>
      renderEnvironmentEntry(environmentKey, index),
    ),
    listClassName: "environment-list",
  });
}

function renderEnvironmentCreationPanel(options: {
  environmentCount: number;
  state: "empty" | "populated";
  tenantId: string;
}): string {
  return renderSidePanel({
    as: "aside",
    attributes: {
      "data-environment-panel": "creation",
    },
    className: "card stack environment-panel environment-panel--creation",
    sections: [
      `<section class="environment-secondary-card environment-secondary-card--summary stack">
        <span class="shell-eyebrow">Secondary Action</span>
        <h2>Add Environment</h2>
        <p class="meta">Create a new environment key without changing field names, POST targets, or redirect behavior.</p>
        <p>${
          options.state === "empty"
            ? "Register the first tenant environment to unlock truthful publication targeting."
            : "Register one environment key at a time so new publication targets appear without changing the existing environment flow."
        }</p>
        <div class="environment-creation-status">
          ${renderPill(`${options.environmentCount} configured`)}
          ${renderPill(options.state === "empty" ? "Awaiting first target" : "Inventory remains primary")}
        </div>
      </section>`,
      renderFormSection({
        className: "environment-secondary-card environment-secondary-card--form",
        description: "Use short stable keys such as qa, staging, or prod.",
        eyebrow: "Creation Workflow",
        title: "Register Environment",
        body: `<form class="environment-form" action="/tenants/${encodeURIComponent(options.tenantId)}/environments" method="post">
          ${renderFormField({
            inputMarkup: '<input name="environmentKey" placeholder="qa" />',
            label: "Environment key",
            supportingText: "The exact field name remains unchanged for the existing POST workflow.",
          })}
          <div class="environment-form__actions">
            <button type="submit">Add Environment</button>
            <p class="meta">The current POST target and redirect behavior remain unchanged.</p>
          </div>
        </form>`,
      }),
    ],
  });
}

export function renderEnvironmentManagementPage(
  options: EnvironmentManagementPageOptions,
): string {
  const state = options.environmentKeys.length === 0 ? "empty" : "populated";
  const environmentCount = options.environmentKeys.length;

  return `<div class="environment-page" data-environment-layout="management" data-environment-state="${state}">
    ${renderSectionFrame({
      as: "section",
      className: "hero card stack page-hero environment-hero",
      description:
        "Configured environments stay primary, while creation remains a secondary panel that preserves the existing POST target and redirect behavior.",
      eyebrow: "Tenant Operations",
      headerContent: `<div class="environment-hero__meta">
        <p class="meta">Tenant ${escapeHtml(options.tenantId)}</p>
        ${renderPill(`${environmentCount} configured`)}
      </div>`,
      title: "Environment Management",
      titleTag: "h1",
      body: `<div class="environment-hero__stats" aria-label="Environment management summary">
        ${renderStatTile({
          className: "environment-hero__stat",
          description:
            environmentCount === 0
              ? "Add the first target to unlock truthful publication destinations."
              : "Current publication destinations remain ready for truthful draft routing.",
          eyebrow: "Configured Targets",
          value: String(environmentCount),
        })}
        ${renderStatTile({
          className: "environment-hero__stat",
          description: "Admin-only registration continues to post with the unchanged environmentKey field.",
          eyebrow: "Creation Flow",
          value: "POST",
        })}
      </div>`,
    })}
    <section class="environment-layout">
      ${renderSectionFrame({
        as: "section",
        attributes: {
          "data-environment-panel": "inventory",
          "data-environment-state": state,
        },
        body: renderEnvironmentInventory(options.environmentKeys),
        className: "card stack environment-panel environment-panel--inventory",
        description:
          "Use this tenant record as the source of truth for where versions can be published.",
        eyebrow: "Configured Inventory",
        headerContent: `<div class="environment-inventory__status">
          ${renderPill(state === "empty" ? "Awaiting first target" : "Ready for publication")}
        </div>`,
        title: "Configured Environments",
      })}
      ${renderEnvironmentCreationPanel({
        environmentCount,
        state,
        tenantId: options.tenantId,
      })}
    </section>
  </div>`;
}
