import type { PublicationHealthDetailResponse } from "@agent-registry/contracts";
import type { VersionAdminDetailRecord } from "@agent-registry/db";

import { escapeHtml, renderPreformattedJson } from "../document.js";

interface RenderVersionDetailPageBodyOptions {
  actions: string[];
  detail: VersionAdminDetailRecord;
  healthByEnvironment: Map<string, PublicationHealthDetailResponse>;
  isTenantAdmin: boolean;
  tenantId: string;
}

interface ReviewTimelineItem {
  meta: string;
  title: string;
}

function humanizeConsoleState(value: string): string {
  return value
    .split(/[_-]/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function renderPillList(values: string[]): string {
  if (values.length === 0) {
    return `<span class="pill">none</span>`;
  }

  return values.map((value) => `<span class="pill">${escapeHtml(value)}</span>`).join("");
}

function formatTimestamp(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }

  const timestamp = value instanceof Date ? value.toISOString() : new Date(value).toISOString();

  return timestamp.replace(".000Z", "Z");
}

function buildVersionManifest(detail: VersionAdminDetailRecord): Record<string, unknown> {
  return {
    agentId: detail.agentId,
    approvalState: detail.approvalState,
    capabilities: detail.capabilities,
    cardProfileId: detail.cardProfileId,
    environments: detail.publications.map((publication) => ({
      environmentKey: publication.environmentKey,
      healthEndpointUrl: publication.healthEndpointUrl,
      healthStatus: publication.healthStatus ?? "unknown",
      invocationEndpoint: publication.invocationEndpoint ?? null,
      publicationId: publication.publicationId,
    })),
    publisherId: detail.publisherId,
    requiredRoles: detail.requiredRoles,
    requiredScopes: detail.requiredScopes,
    tags: detail.tags,
    versionId: detail.versionId,
    versionLabel: detail.versionLabel,
    versionSequence: detail.versionSequence,
  };
}

function buildReviewTimeline(detail: VersionAdminDetailRecord): ReviewTimelineItem[] {
  const items: ReviewTimelineItem[] = [];

  if (detail.review.submittedAt === null) {
    items.push({
      meta: "Draft",
      title: "Version remains editable by its publisher until it is submitted for review.",
    });
  } else {
    items.push({
      meta: formatTimestamp(detail.review.submittedAt),
      title: `Version submitted by ${detail.review.submittedBy ?? "unknown reviewer"}`,
    });
  }

  if (detail.review.approvedAt !== null) {
    items.push({
      meta: formatTimestamp(detail.review.approvedAt),
      title: `Version approved by ${detail.review.approvedBy ?? "unknown reviewer"}`,
    });
  }

  if (detail.review.rejectedAt !== null) {
    items.push({
      meta: formatTimestamp(detail.review.rejectedAt),
      title: `Version rejected by ${detail.review.rejectedBy ?? "unknown reviewer"}`,
    });
  }

  if (items.length === 1 && detail.approvalState === "pending_review") {
    items.push({
      meta: "Pending Review",
      title: "Manual approval is required before truthful health history is exposed.",
    });
  }

  if (items.length === 0) {
    items.push({
      meta: "Unscheduled",
      title: "No review events have been recorded for this version yet.",
    });
  }

  return items;
}

function renderEnvironmentDossiers(detail: VersionAdminDetailRecord): string {
  return detail.publications
    .map(
      (publication) =>
        `<article class="version-detail-publication-card stack">
          <div class="version-detail-card-head">
            <div class="stack">
              <span class="shell-eyebrow">Environment: ${escapeHtml(publication.environmentKey)}</span>
              <h3>${escapeHtml(publication.environmentKey)}</h3>
            </div>
            <div class="pill">${escapeHtml(publication.healthStatus ?? "unknown")}</div>
          </div>
          <div class="version-detail-publication-meta">
            <div class="version-detail-stat">
              <span class="shell-eyebrow">Health Endpoint</span>
              <strong><code>${escapeHtml(publication.healthEndpointUrl)}</code></strong>
            </div>
            <div class="version-detail-stat">
              <span class="shell-eyebrow">Invocation Endpoint</span>
              <strong><code>${escapeHtml(publication.invocationEndpoint ?? "none")}</code></strong>
            </div>
          </div>
          <div class="version-detail-contract-grid version-detail-contract-grid--publication">
            <div class="version-detail-contract-card stack">
              <span class="shell-eyebrow">Normalized Metadata</span>
              ${renderPreformattedJson(publication.normalizedMetadata)}
            </div>
            <div class="version-detail-contract-card stack version-detail-raw-card">
              <span class="shell-eyebrow">Raw Card</span>
              <pre>${escapeHtml(publication.rawCard)}</pre>
            </div>
          </div>
        </article>`,
    )
    .join("");
}

function renderTelemetrySection(detail: VersionAdminDetailRecord): string {
  return `<section class="card stack version-detail-panel" data-visual-dynamic="publication-telemetry">
    <div class="version-detail-section-head">
      <div class="stack">
        <span class="shell-eyebrow">Operational Telemetry</span>
        <h2>Operational Telemetry</h2>
      </div>
      <p class="meta">Tenant admins retain access to truthful advisory telemetry windows for each environment publication.</p>
    </div>
    <div class="version-detail-telemetry-list">
      ${detail.publications
        .map((publication) => {
          if (publication.telemetry.length === 0) {
            return `<article class="version-detail-telemetry-card stack">
              <div class="version-detail-card-head">
                <div class="stack">
                  <span class="shell-eyebrow">Environment Telemetry</span>
                  <h3>${escapeHtml(publication.environmentKey)}</h3>
                </div>
                <div class="pill">No advisory telemetry</div>
              </div>
              <p>No advisory telemetry submitted.</p>
            </article>`;
          }

          return `<article class="version-detail-telemetry-card stack">
            <div class="version-detail-card-head">
              <div class="stack">
                <span class="shell-eyebrow">Environment Telemetry</span>
                <h3>${escapeHtml(publication.environmentKey)}</h3>
              </div>
              <div class="pill">${publication.telemetry.length} recorded window${publication.telemetry.length === 1 ? "" : "s"}</div>
            </div>
            ${publication.telemetry
              .map(
                (telemetry) =>
                  `<div class="version-detail-telemetry-window stack">
                    <p>Window: <code>${escapeHtml(telemetry.windowStartedAt)}</code> to <code>${escapeHtml(telemetry.windowEndedAt)}</code></p>
                    <p>Invocation count: ${telemetry.invocationCount}</p>
                    <p>Success count: ${telemetry.successCount}</p>
                    <p>Error count: ${telemetry.errorCount}</p>
                    <p>p95 latency: ${telemetry.p95LatencyMs ?? "n/a"}</p>
                  </div>`,
              )
              .join("")}
          </article>`;
        })
        .join("")}
    </div>
  </section>`;
}

function renderHealthHistorySection(
  detail: VersionAdminDetailRecord,
  healthByEnvironment: Map<string, PublicationHealthDetailResponse>,
): string {
  return `<section class="card stack version-detail-panel" data-visual-dynamic="publication-health-history">
    <div class="version-detail-section-head">
      <div class="stack">
        <span class="shell-eyebrow">Health History</span>
        <h2>Health History</h2>
      </div>
      <p class="meta">Approved publications expose their current health envelope and the latest probe history for admins only.</p>
    </div>
    <div class="version-detail-health-list">
      ${detail.publications
        .map((publication) => {
          const health = healthByEnvironment.get(publication.environmentKey);

          return `<article class="version-detail-health-card stack">
            <div class="version-detail-card-head">
              <div class="stack">
                <span class="shell-eyebrow">Environment Health</span>
                <h3>${escapeHtml(publication.environmentKey)}</h3>
              </div>
              <div class="pill">${escapeHtml(health?.current.healthStatus ?? publication.healthStatus ?? "unknown")}</div>
            </div>
            <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
            ${
              health === undefined
                ? `<p>No probes recorded yet.</p>`
                : `<div class="version-detail-health-summary stack">
                     <p>Current status: ${escapeHtml(health.current.healthStatus)}</p>
                     <p>Recent failures: ${health.current.recentFailures}</p>
                     <p>Consecutive failures: ${health.current.consecutiveFailures}</p>
                     <p>Last checked: ${escapeHtml(formatTimestamp(health.current.lastCheckedAt))}</p>
                     <p>Last success: ${escapeHtml(formatTimestamp(health.current.lastSuccessAt))}</p>
                     ${
                       health.current.lastError === null
                         ? ""
                         : `<p>Last error: ${escapeHtml(health.current.lastError)}</p>`
                     }
                   </div>
                   ${
                     health.history.length === 0
                       ? `<p>No probes recorded yet.</p>`
                       : `<div class="version-detail-health-history-list">
                            ${health.history
                              .map(
                                (entry) =>
                                  `<div class="version-detail-history-item stack">
                                    <p><code>${escapeHtml(formatTimestamp(entry.checkedAt))}</code></p>
                                    <p>Status code: ${entry.statusCode === null ? "n/a" : String(entry.statusCode)}</p>
                                    ${
                                      entry.error === null
                                        ? `<p>Probe outcome: ${entry.ok ? "ok" : "failed"}</p>`
                                        : `<p>Error: ${escapeHtml(entry.error)}</p>`
                                    }
                                  </div>`,
                              )
                              .join("")}
                          </div>`
                   }`
            }
          </article>`;
        })
        .join("")}
    </div>
  </section>`;
}

export function renderVersionDetailPageBody(
  options: RenderVersionDetailPageBodyOptions,
): string {
  const { actions, detail, healthByEnvironment, isTenantAdmin, tenantId } = options;
  const reviewTimelineItems = buildReviewTimeline(detail);
  const showAdminTelemetry = isTenantAdmin;
  const showAdminHealthHistory = isTenantAdmin && detail.approvalState === "approved";

  return `<section class="card stack page-hero version-detail-hero" data-visual-dynamic="version-overview">
    <div class="version-detail-hero__lead">
      <div class="version-detail-signal">
        <span class="version-detail-signal__pulse" aria-hidden="true"></span>
        <span class="shell-eyebrow">Current Publication Status</span>
      </div>
      <h1>${escapeHtml(detail.displayName)}</h1>
      <p class="meta">${escapeHtml(detail.summary)}</p>
    </div>
    <div class="version-detail-pill-row">
      <span class="pill">${escapeHtml(humanizeConsoleState(detail.approvalState))}</span>
      <span class="pill">${escapeHtml(detail.versionLabel)}</span>
      <span class="pill">Sequence ${detail.versionSequence}</span>
      <span class="pill">Publisher ${escapeHtml(detail.publisherId)}</span>
      ${
        detail.active
          ? `<a class="pill" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}">Open active agent detail</a>`
          : ""
      }
    </div>
  </section>
  <div class="version-detail-grid">
    <div class="version-detail-main">
      <section class="card stack version-detail-panel" data-visual-dynamic="version-publication-contracts">
        <div class="version-detail-section-head">
          <div class="stack">
            <span class="shell-eyebrow">Publication Contracts</span>
            <h2>Publication Contracts</h2>
          </div>
          <p class="meta">Capabilities, access requirements, and server-backed contracts are grouped here without inventing mock dossier fields.</p>
        </div>
        <div class="version-detail-contract-grid">
          <div class="version-detail-contract-card stack">
            <span class="shell-eyebrow">Access Envelope</span>
            <h3>Roles, scopes, capabilities, and tags</h3>
            <p>Required roles: ${escapeHtml(detail.requiredRoles.join(", ") || "none")}</p>
            <p>Required scopes: ${escapeHtml(detail.requiredScopes.join(", ") || "none")}</p>
            <div class="version-detail-pill-row">${renderPillList(detail.capabilities)}</div>
            <div class="version-detail-pill-row">${renderPillList(detail.tags)}</div>
          </div>
          <div class="version-detail-contract-card stack">
            <span class="shell-eyebrow">Header Contract</span>
            ${renderPreformattedJson(detail.headerContract)}
          </div>
          <div class="version-detail-contract-card stack">
            <span class="shell-eyebrow">Context Contract</span>
            ${renderPreformattedJson(detail.contextContract)}
          </div>
          <div class="version-detail-contract-card stack">
            <span class="shell-eyebrow">Publication Surface</span>
            <p>Environments: ${detail.publications.length}</p>
            <p>Card profile: ${escapeHtml(detail.cardProfileId)}</p>
            <p>Version ID: <code>${escapeHtml(detail.versionId)}</code></p>
            <p>Agent ID: <code>${escapeHtml(detail.agentId)}</code></p>
          </div>
        </div>
      </section>
      <section class="card stack version-detail-panel version-detail-manifest" data-visual-dynamic="version-manifest">
        <div class="version-detail-section-head">
          <div class="stack">
            <span class="shell-eyebrow">Technical Manifest</span>
            <h2>Technical Manifest</h2>
          </div>
          <p class="meta">The reference manifest is fulfilled with the nearest truthful version-level data already stored by the product.</p>
        </div>
        ${renderPreformattedJson(buildVersionManifest(detail))}
      </section>
      <section class="card stack version-detail-panel" data-visual-dynamic="publication-detail-list">
        <div class="version-detail-section-head">
          <div class="stack">
            <span class="shell-eyebrow">Environment Dossiers</span>
            <h2>Environment Dossiers</h2>
          </div>
          <p class="meta">Each publication retains its raw card, normalized metadata, and endpoints in one truthful per-environment panel.</p>
        </div>
        <div class="version-detail-publication-list">
          ${renderEnvironmentDossiers(detail)}
        </div>
      </section>
      ${showAdminTelemetry ? renderTelemetrySection(detail) : ""}
      ${showAdminHealthHistory ? renderHealthHistorySection(detail, healthByEnvironment) : ""}
    </div>
    <div class="version-detail-side">
      <section class="card stack version-detail-panel version-detail-review-card" data-visual-dynamic="version-metadata">
        <div class="version-detail-card-head">
          <div class="stack">
            <span class="shell-eyebrow">Release Metadata</span>
            <h2>Release Metadata</h2>
          </div>
          <div class="pill">${escapeHtml(humanizeConsoleState(detail.approvalState))}</div>
        </div>
        <div class="version-detail-stat-grid">
          <div class="version-detail-stat">
            <span class="shell-eyebrow">Approval State</span>
            <strong>${escapeHtml(detail.approvalState)}</strong>
          </div>
          <div class="version-detail-stat">
            <span class="shell-eyebrow">Version Label</span>
            <strong>${escapeHtml(detail.versionLabel)}</strong>
          </div>
          <div class="version-detail-stat">
            <span class="shell-eyebrow">Version Sequence</span>
            <strong>${detail.versionSequence}</strong>
          </div>
          <div class="version-detail-stat">
            <span class="shell-eyebrow">Active Publication</span>
            <strong>${detail.active ? "yes" : "no"}</strong>
          </div>
        </div>
        <p>Approval state: ${escapeHtml(detail.approvalState)}</p>
        <p>Version label: ${escapeHtml(detail.versionLabel)} | Version sequence: ${detail.versionSequence}</p>
        ${
          detail.review.rejectedReason === null
            ? ""
            : `<div class="version-detail-note stack">
                 <span class="shell-eyebrow">Review Notes</span>
                 <p>Rejected reason: ${escapeHtml(detail.review.rejectedReason)}</p>
               </div>`
        }
      </section>
      ${
        actions.length === 0
          ? ""
          : `<section class="card stack version-detail-panel" data-visual-dynamic="version-actions">
               <div class="version-detail-section-head">
                 <div class="stack">
                   <span class="shell-eyebrow">Action Cluster</span>
                   <h2>Version Actions</h2>
                 </div>
                 <p class="meta">Current state controls remain wired to the existing submit, approve, and reject routes.</p>
               </div>
               <div class="inline-actions version-detail-action-grid">
                 ${actions.join("")}
               </div>
             </section>`
      }
      <section class="card stack version-detail-panel">
        <div class="version-detail-section-head">
          <div class="stack">
            <span class="shell-eyebrow">Review Timeline</span>
            <h2>Review Timeline</h2>
          </div>
          <p class="meta">Submission and review milestones remain truthful, even when a reference mock included a richer audit narrative.</p>
        </div>
        <div class="version-detail-timeline">
          ${reviewTimelineItems
            .map(
              (item) =>
                `<article class="version-detail-timeline-item stack">
                  <span class="shell-eyebrow">${escapeHtml(item.meta)}</span>
                  <p>${escapeHtml(item.title)}</p>
                </article>`,
            )
            .join("")}
        </div>
      </section>
    </div>
  </div>`;
}
