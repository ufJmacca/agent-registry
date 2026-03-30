import { escapeHtml } from "../document.js";
import {
  renderActionCluster,
  renderCardHead,
  renderEmptyState,
  renderPill,
  renderStatTile,
} from "../primitives/index.js";

interface ReviewQueuePageEntry {
  agentId: string;
  displayName: string;
  publisherId: string;
  submittedAt: string | null;
  versionId: string;
  versionLabel: string;
  versionSequence: number;
}

interface ReviewQueuePageOptions {
  entries: ReviewQueuePageEntry[];
  tenantId: string;
}

function renderReviewQueueEntry(options: {
  entry: ReviewQueuePageEntry;
  tenantId: string;
}): string {
  const { entry, tenantId } = options;
  const versionDetailPath = `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}`;
  const approvePath = `${versionDetailPath}/approve`;
  const rejectPath = `${versionDetailPath}/reject`;

  return `<li class="review-queue-record card" data-review-entry="${escapeHtml(entry.versionId)}" data-review-object="curated">
    <div class="review-queue-record__identity" data-review-band="identity">
      <div class="review-queue-record__lead stack">
        <span class="shell-eyebrow">Pending Review</span>
        <div class="review-queue-record__headline">
          <h2>${escapeHtml(entry.displayName)}</h2>
          <p class="meta">Version ${entry.versionSequence} is awaiting tenant-admin approval.</p>
        </div>
      </div>
      <div class="review-queue-record__signals">
        ${renderPill(entry.versionLabel, {
          className: "review-queue-record__version",
        })}
        ${renderPill("Ready for decision", {
          className: "review-queue-record__status",
        })}
      </div>
    </div>
    <dl class="review-queue-record__facts" data-review-band="facts">
      <div class="review-queue-record__fact">
        <dt>Publisher</dt>
        <dd>${escapeHtml(entry.publisherId)}</dd>
      </div>
      <div class="review-queue-record__fact">
        <dt>Submitted</dt>
        <dd>${entry.submittedAt === null ? "Awaiting submission" : escapeHtml(entry.submittedAt)}</dd>
      </div>
      <div class="review-queue-record__fact">
        <dt>Version</dt>
        <dd>${escapeHtml(entry.versionLabel)} · Revision ${entry.versionSequence}</dd>
      </div>
    </dl>
    <div class="review-queue-record__actions" data-review-band="actions">
      ${renderActionCluster({
        actions: [
          `<a class="review-queue-record__detail-link" href="${escapeHtml(versionDetailPath)}">Version detail</a>`,
          `<form action="${escapeHtml(approvePath)}" method="post">
             <button type="submit">Approve</button>
           </form>`,
        ],
        className: "review-queue-record__primary-actions",
      })}
      <form class="review-queue-record__reject stack" action="${escapeHtml(rejectPath)}" method="post">
        <label>Reject reason
          <input name="reason" placeholder="Needs clearer scopes." />
        </label>
        <button class="button-secondary" type="submit">Reject</button>
      </form>
    </div>
  </li>`;
}

export function renderReviewQueuePage(options: ReviewQueuePageOptions): string {
  const state = options.entries.length === 0 ? "empty" : "populated";

  return `<section class="review-queue-page stack" data-review-layout="curated-queue" data-review-state="${state}">
    <section class="hero card stack page-hero review-queue-hero" data-review-intro="hero">
      <div class="review-queue-hero__lead stack">
        <span class="shell-eyebrow">Review Authority</span>
        <h1>Review Queue</h1>
        <p class="meta">Tenant-admin decisions stay immediate, truthful, and routed through the current approve and reject actions.</p>
        <p>Approve or reject each submission directly from the queue while using version detail for the full technical dossier.</p>
      </div>
      <div class="review-queue-hero__stats">
        ${renderStatTile({
          className: "review-queue-hero__stat",
          description: `Pending versions for ${options.tenantId}`,
          eyebrow: "Decision Queue",
          includeBaseClass: false,
          value: String(options.entries.length),
        })}
        ${renderStatTile({
          className: "review-queue-hero__stat",
          description: state === "empty" ? "Awaiting the next submitted version." : "Immediate tenant-admin approval or rejection remains available.",
          eyebrow: "Queue State",
          includeBaseClass: false,
          value: state === "empty" ? "Clear" : "Active",
        })}
      </div>
    </section>
    <section class="review-queue-panel card stack" data-visual-dynamic="review-queue" data-review-state="${state}">
      ${renderCardHead({
        className: "review-queue-panel__head",
        description: `Pending versions for ${options.tenantId}`,
        eyebrow: "Decision Queue",
        title: state === "empty" ? "No pending review objects" : "Pending review objects",
        trailingContent: renderPill(`${options.entries.length} pending`, {
          className: "review-queue-panel__status",
        }),
      })}
      ${
        options.entries.length === 0
          ? renderEmptyState({
              className: "review-queue-empty",
              eyebrow: "Queue State",
              title: "No versions are awaiting review.",
              body: "Newly submitted versions will appear here with live decision actions as soon as they enter tenant-admin review.",
            })
          : `<ol class="review-queue-list" aria-label="Pending versions awaiting review">
              ${options.entries
                .map((entry) =>
                  renderReviewQueueEntry({
                    entry,
                    tenantId: options.tenantId,
                  }),
                )
                .join("")}
            </ol>`
      }
    </section>
  </section>`;
}
