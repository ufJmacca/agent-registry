import type { PublicationHealthDetailResponse } from "@agent-registry/contracts";
import type { VersionAdminDetailRecord } from "@agent-registry/db";

import { escapeHtml, renderPreformattedJson } from "../document.js";
import {
  formatConsoleState,
  formatConsoleTimestamp,
  renderActionCluster,
  renderCardHead,
  renderPageHero,
  renderPill,
  renderPillList,
  renderRecordList,
  renderSectionFrame,
  renderSidePanel,
  renderStatTile,
} from "../primitives/index.js";

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

interface ReviewStateSignal {
  eyebrow: string;
  meta?: string;
  title: string;
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
      meta: formatConsoleTimestamp(detail.review.submittedAt),
      title: `Version submitted by ${detail.review.submittedBy ?? "unknown reviewer"}`,
    });
  }

  if (detail.review.approvedAt !== null) {
    items.push({
      meta: formatConsoleTimestamp(detail.review.approvedAt),
      title: `Version approved by ${detail.review.approvedBy ?? "unknown reviewer"}`,
    });
  }

  if (detail.review.rejectedAt !== null) {
    items.push({
      meta: formatConsoleTimestamp(detail.review.rejectedAt),
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

function buildReviewStateSignals(detail: VersionAdminDetailRecord): ReviewStateSignal[] {
  const signals: ReviewStateSignal[] = [
    {
      eyebrow: "Lifecycle State",
      meta: `Version label: ${detail.versionLabel} | Version sequence: ${detail.versionSequence}`,
      title: `Approval state: ${detail.approvalState}`,
    },
    {
      eyebrow: "Submission",
      meta:
        detail.review.submittedAt === null
          ? "Publishers can keep editing until the review handoff occurs."
          : "Submission timing and ownership remain truthful to the stored review record.",
      title:
        detail.review.submittedAt === null
          ? "Draft has not been submitted for review yet."
          : `Submitted ${formatConsoleTimestamp(detail.review.submittedAt)} by ${detail.review.submittedBy ?? "unknown reviewer"}`,
    },
  ];

  if (detail.review.approvedAt !== null) {
    signals.push({
      eyebrow: "Approval",
      meta: "Approved versions expose the truthful admin telemetry and health envelope.",
      title: `Approved ${formatConsoleTimestamp(detail.review.approvedAt)} by ${detail.review.approvedBy ?? "unknown reviewer"}`,
    });
  } else if (detail.review.rejectedAt !== null) {
    signals.push({
      eyebrow: "Rejection",
      meta: detail.review.rejectedReason ?? "A tenant-admin rejection reason is recorded for this version.",
      title: `Rejected ${formatConsoleTimestamp(detail.review.rejectedAt)} by ${detail.review.rejectedBy ?? "unknown reviewer"}`,
    });
  } else if (detail.approvalState === "pending_review") {
    signals.push({
      eyebrow: "Manual Approval",
      meta: "Manual approval is required before truthful health history is exposed.",
      title: "Awaiting tenant-admin approval.",
    });
  } else {
    signals.push({
      eyebrow: "Publication Surface",
      meta: "Lifecycle state stays truthful even when the reference uses richer operational review badges.",
      title: detail.active
        ? "This version is currently the active approved publication."
        : "This version is not currently active.",
    });
  }

  return signals;
}

function renderEnvironmentDossiers(detail: VersionAdminDetailRecord): string {
  return renderRecordList({
    items: detail.publications.map(
      (publication) =>
        `<article class="version-detail-publication-card stack">
          ${renderCardHead({
            className: "version-detail-card-head",
            eyebrow: `Environment: ${publication.environmentKey}`,
            title: publication.environmentKey,
            titleTag: "h3",
            trailingContent: renderPill(publication.healthStatus ?? "unknown"),
          })}
          <div class="version-detail-publication-meta">
            ${renderStatTile({
              className: "version-detail-stat",
              eyebrow: "Health Endpoint",
              valueMarkup: `<code>${escapeHtml(publication.healthEndpointUrl)}</code>`,
            })}
            ${renderStatTile({
              className: "version-detail-stat",
              eyebrow: "Invocation Endpoint",
              valueMarkup: `<code>${escapeHtml(publication.invocationEndpoint ?? "none")}</code>`,
            })}
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
    ),
    listClassName: "record-list version-detail-publication-list",
  });
}

function renderTelemetrySection(detail: VersionAdminDetailRecord): string {
  return renderSectionFrame({
    attributes: {
      "data-visual-dynamic": "publication-telemetry",
    },
    body: renderRecordList({
      items: detail.publications.map((publication) => {
        if (publication.telemetry.length === 0) {
          return `<article class="version-detail-telemetry-card stack">
            ${renderCardHead({
              className: "version-detail-card-head",
              eyebrow: "Environment Telemetry",
              title: publication.environmentKey,
              titleTag: "h3",
              trailingContent: renderPill("No advisory telemetry"),
            })}
            <p>No advisory telemetry submitted.</p>
          </article>`;
        }

        return `<article class="version-detail-telemetry-card stack">
          ${renderCardHead({
            className: "version-detail-card-head",
            eyebrow: "Environment Telemetry",
            title: publication.environmentKey,
            titleTag: "h3",
            trailingContent: renderPill(
              `${publication.telemetry.length} recorded window${publication.telemetry.length === 1 ? "" : "s"}`,
            ),
          })}
          ${publication.telemetry
            .map(
              (telemetry) =>
                `<div class="version-detail-telemetry-window stack">
                  <p>Window: <code>${escapeHtml(formatConsoleTimestamp(telemetry.windowStartedAt))}</code> to <code>${escapeHtml(formatConsoleTimestamp(telemetry.windowEndedAt))}</code></p>
                  <p>Invocation count: ${telemetry.invocationCount}</p>
                  <p>Success count: ${telemetry.successCount}</p>
                  <p>Error count: ${telemetry.errorCount}</p>
                  <p>p95 latency: ${telemetry.p95LatencyMs ?? "n/a"}</p>
                </div>`,
            )
            .join("")}
        </article>`;
      }),
      listClassName: "record-list version-detail-telemetry-list",
    }),
    className: "card stack version-detail-panel",
    description:
      "Tenant admins retain access to truthful advisory telemetry windows for each environment publication.",
    eyebrow: "Operational Telemetry",
    headerClassName: "version-detail-section-head",
    title: "Operational Telemetry",
  });
}

function renderHealthHistorySection(
  detail: VersionAdminDetailRecord,
  healthByEnvironment: Map<string, PublicationHealthDetailResponse>,
): string {
  return renderSectionFrame({
    attributes: {
      "data-visual-dynamic": "publication-health-history",
    },
    body: renderRecordList({
      items: detail.publications.map((publication) => {
        const health = healthByEnvironment.get(publication.environmentKey);

        return `<article class="version-detail-health-card stack">
          ${renderCardHead({
            className: "version-detail-card-head",
            eyebrow: "Environment Health",
            title: publication.environmentKey,
            titleTag: "h3",
            trailingContent: renderPill(
              health?.current.healthStatus ?? publication.healthStatus ?? "unknown",
            ),
          })}
          <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
          ${
            health === undefined
              ? `<p>No probes recorded yet.</p>`
              : `<div class="version-detail-health-summary stack">
                   <p>Current status: ${escapeHtml(health.current.healthStatus)}</p>
                   <p>Recent failures: ${health.current.recentFailures}</p>
                   <p>Consecutive failures: ${health.current.consecutiveFailures}</p>
                   <p>Last checked: ${escapeHtml(formatConsoleTimestamp(health.current.lastCheckedAt))}</p>
                   <p>Last success: ${escapeHtml(formatConsoleTimestamp(health.current.lastSuccessAt))}</p>
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
                                  <p><code>${escapeHtml(formatConsoleTimestamp(entry.checkedAt))}</code></p>
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
      }),
      listClassName: "record-list version-detail-health-list",
    }),
    className: "card stack version-detail-panel",
    description:
      "Approved publications expose their current health envelope and the latest probe history for admins only.",
    eyebrow: "Health History",
    headerClassName: "version-detail-section-head",
    title: "Health History",
  });
}

export function renderVersionDetailPageBody(
  options: RenderVersionDetailPageBodyOptions,
): string {
  const { actions, detail, healthByEnvironment, isTenantAdmin, tenantId } = options;
  const reviewTimelineItems = buildReviewTimeline(detail);
  const reviewStateSignals = buildReviewStateSignals(detail);
  const showAdminTelemetry = isTenantAdmin;
  const showAdminHealthHistory = isTenantAdmin && detail.approvalState === "approved";

  return `<div class="version-detail-layout" data-version-detail-layout="dossier">
    ${renderPageHero({
      attributes: {
        "data-visual-dynamic": "version-overview",
      },
      body: `<div class="version-detail-hero__lead">
          <div class="version-detail-signal">
            <span class="version-detail-signal__pulse" aria-hidden="true"></span>
            <span class="shell-eyebrow">Current Publication Status</span>
          </div>
          <h1>${escapeHtml(detail.displayName)}</h1>
          <p class="meta">${escapeHtml(detail.summary)}</p>
        </div>
        <div class="version-detail-stat-grid" aria-label="Version detail summary">
          ${renderStatTile({
            className: "version-detail-stat",
            eyebrow: "Approval State",
            value: formatConsoleState(detail.approvalState),
          })}
          ${renderStatTile({
            className: "version-detail-stat",
            eyebrow: "Version Label",
            value: detail.versionLabel,
          })}
          ${renderStatTile({
            className: "version-detail-stat",
            eyebrow: "Version Sequence",
            value: String(detail.versionSequence),
          })}
          ${renderStatTile({
            className: "version-detail-stat",
            eyebrow: "Published Environments",
            value: String(detail.publications.length),
          })}
        </div>
        <div class="version-detail-pill-row">
          ${renderPill(formatConsoleState(detail.approvalState))}
          ${renderPill(detail.versionLabel)}
          ${renderPill(`Sequence ${detail.versionSequence}`)}
          ${renderPill(`Publisher ${detail.publisherId}`)}
          ${
            detail.active
              ? renderPill("Open active agent detail", {
                  href: `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(detail.agentId)}`,
                })
              : ""
          }
        </div>`,
      className: "card stack version-detail-hero page-hero--dossier",
    })}
    <div class="version-detail-grid">
      <div class="version-detail-main">
        ${renderSectionFrame({
          attributes: {
            "data-visual-dynamic": "version-publication-contracts",
          },
          body: renderRecordList({
            items: [
              `<div class="version-detail-contract-card stack">
                <span class="shell-eyebrow">Access Envelope</span>
                <h3>Roles, scopes, capabilities, and tags</h3>
                <p>Required roles: ${escapeHtml(detail.requiredRoles.join(", ") || "none")}</p>
                <p>Required scopes: ${escapeHtml(detail.requiredScopes.join(", ") || "none")}</p>
                <div class="version-detail-pill-row">${renderPillList(detail.capabilities)}</div>
                <div class="version-detail-pill-row">${renderPillList(detail.tags)}</div>
              </div>`,
              `<div class="version-detail-contract-card stack">
                <span class="shell-eyebrow">Header Contract</span>
                ${renderPreformattedJson(detail.headerContract)}
              </div>`,
              `<div class="version-detail-contract-card stack">
                <span class="shell-eyebrow">Context Contract</span>
                ${renderPreformattedJson(detail.contextContract)}
              </div>`,
              `<div class="version-detail-contract-card stack">
                <span class="shell-eyebrow">Publication Surface</span>
                <p>Environments: ${detail.publications.length}</p>
                <p>Card profile: ${escapeHtml(detail.cardProfileId)}</p>
                <p>Version ID: <code>${escapeHtml(detail.versionId)}</code></p>
                <p>Agent ID: <code>${escapeHtml(detail.agentId)}</code></p>
              </div>`,
            ],
            listClassName: "record-list version-detail-contract-grid",
          }),
          className: "card stack version-detail-panel",
          description:
            "Capabilities, access requirements, and server-backed contracts are grouped here without inventing mock dossier fields.",
          eyebrow: "Publication Contracts",
          headerClassName: "version-detail-section-head",
          title: "Publication Contracts",
        })}
        ${renderSectionFrame({
          attributes: {
            "data-visual-dynamic": "version-manifest",
          },
          body: renderPreformattedJson(buildVersionManifest(detail)),
          className: "card stack version-detail-panel version-detail-manifest",
          description:
            "The reference manifest is fulfilled with the nearest truthful version-level data already stored by the product.",
          eyebrow: "Technical Manifest",
          headerClassName: "version-detail-section-head",
          title: "Technical Manifest",
        })}
        ${renderSectionFrame({
          attributes: {
            "data-visual-dynamic": "publication-detail-list",
          },
          body: renderEnvironmentDossiers(detail),
          className: "card stack version-detail-panel",
          description:
            "Each publication retains its raw card, normalized metadata, and endpoints in one truthful per-environment panel.",
          eyebrow: "Environment Dossiers",
          headerClassName: "version-detail-section-head",
          title: "Environment Dossiers",
        })}
        ${showAdminTelemetry ? renderTelemetrySection(detail) : ""}
        ${showAdminHealthHistory ? renderHealthHistorySection(detail, healthByEnvironment) : ""}
      </div>
      ${renderSidePanel({
        attributes: {
          "data-version-detail-side": "stack",
        },
        className: "version-detail-side",
        sections: [
          renderSectionFrame({
            attributes: {
              "data-visual-dynamic": "version-metadata",
            },
            body: `${renderRecordList({
              items: reviewStateSignals.map(
                (signal) =>
                  `<article class="version-detail-review-signal stack">
                    <span class="shell-eyebrow">${escapeHtml(signal.eyebrow)}</span>
                    <p>${escapeHtml(signal.title)}</p>
                    ${signal.meta === undefined ? "" : `<p class="meta">${escapeHtml(signal.meta)}</p>`}
                  </article>`,
              ),
              listClassName: "record-list version-detail-review-signals",
            })}
            ${
              detail.review.rejectedReason === null
                ? ""
                : `<div class="version-detail-note stack">
                     <span class="shell-eyebrow">Review Notes</span>
                     <p>Rejected reason: ${escapeHtml(detail.review.rejectedReason)}</p>
                   </div>`
            }`,
            className: "card stack version-detail-panel version-detail-review-card",
            eyebrow: "Review State",
            headerClassName: "version-detail-section-head",
            headerContent: renderPill(formatConsoleState(detail.approvalState)),
            title: "Review State",
          }),
          actions.length === 0
            ? ""
            : renderSectionFrame({
                attributes: {
                  "data-visual-dynamic": "version-actions",
                },
                body: renderActionCluster({
                  actions,
                  className: "version-detail-action-grid",
                }),
                className: "card stack version-detail-panel",
                description:
                  "Current state controls remain wired to the existing submit, approve, and reject routes.",
                eyebrow: "Action Cluster",
                headerClassName: "version-detail-section-head",
                title: "Version Actions",
              }),
          renderSectionFrame({
            attributes: {
              "data-visual-dynamic": "version-audit-history",
            },
            body: renderRecordList({
              items: reviewTimelineItems.map(
                (item) =>
                  `<article class="version-detail-timeline-item stack">
                    <span class="shell-eyebrow">${escapeHtml(item.meta)}</span>
                    <p>${escapeHtml(item.title)}</p>
                  </article>`,
              ),
              listClassName: "record-list record-list--history version-detail-timeline",
            }),
            className: "card stack version-detail-panel",
            description:
              "Submission and review milestones remain truthful, even when the reference mock included a richer audit narrative.",
            eyebrow: "Audit History",
            headerClassName: "version-detail-section-head",
            title: "Audit History",
          }),
          renderSectionFrame({
            attributes: {
              "data-visual-dynamic": "version-supporting-metadata",
            },
            body: `<div class="version-detail-metadata-list">
                <div class="version-detail-metadata-row">
                  <span class="shell-eyebrow">Publisher</span>
                  <strong>${escapeHtml(detail.publisherId)}</strong>
                </div>
                <div class="version-detail-metadata-row">
                  <span class="shell-eyebrow">Card Profile</span>
                  <strong>${escapeHtml(detail.cardProfileId)}</strong>
                </div>
                <div class="version-detail-metadata-row">
                  <span class="shell-eyebrow">Version ID</span>
                  <strong><code>${escapeHtml(detail.versionId)}</code></strong>
                </div>
                <div class="version-detail-metadata-row">
                  <span class="shell-eyebrow">Agent ID</span>
                  <strong><code>${escapeHtml(detail.agentId)}</code></strong>
                </div>
              </div>`,
            className: "card stack version-detail-panel",
            description:
              "Reference-only editorial side facts are replaced with truthful version ownership and publication metadata.",
            eyebrow: "Supporting Metadata",
            headerClassName: "version-detail-section-head",
            title: "Supporting Metadata",
          }),
        ].filter((section) => section !== ""),
      })}
    </div>
  </div>`;
}
