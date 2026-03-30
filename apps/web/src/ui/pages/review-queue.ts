import { escapeHtml } from "../document.js";

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

  return `<li class="review-queue-item card">
    <div class="review-queue-item__main">
      <div class="review-queue-item__identity stack">
        <span class="shell-eyebrow">Pending Review</span>
        <div class="review-queue-item__headline">
          <h2>${escapeHtml(entry.displayName)}</h2>
          <span class="pill review-queue-item__version">${escapeHtml(entry.versionLabel)}</span>
        </div>
        <p class="meta">Version ${entry.versionSequence} is awaiting tenant-admin approval.</p>
      </div>
      <dl class="review-queue-item__facts">
        <div>
          <dt>Publisher</dt>
          <dd>${escapeHtml(entry.publisherId)}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>${entry.submittedAt === null ? "Awaiting submission" : escapeHtml(entry.submittedAt)}</dd>
        </div>
        <div>
          <dt>Version Detail</dt>
          <dd><a href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}">Open version detail</a></dd>
        </div>
      </dl>
    </div>
    <div class="review-queue-item__actions">
      <div class="review-queue-item__decision-bar">
        <a class="review-queue-item__detail-link" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}">Version detail</a>
        <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}/approve" method="post">
          <button type="submit">Approve</button>
        </form>
      </div>
      <form class="review-queue-item__reject stack" action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}/reject" method="post">
        <label>Reject reason
          <input name="reason" placeholder="Needs clearer scopes." />
        </label>
        <button class="button-secondary" type="submit">Reject</button>
      </form>
    </div>
  </li>`;
}

export function renderReviewQueuePage(options: ReviewQueuePageOptions): string {
  return `<section class="hero card stack page-hero">
    <span class="shell-eyebrow">Decision Queue</span>
    <h1>Review Queue</h1>
    <p class="meta">Pending versions for ${escapeHtml(options.tenantId)}</p>
    <p>Approve or reject each submission directly from the queue while using version detail for the full technical dossier.</p>
  </section>
  <section class="review-queue stack" data-visual-dynamic="review-queue">
    ${
      options.entries.length === 0
        ? `<div class="card review-queue-empty"><p>No versions are awaiting review.</p></div>`
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
  </section>`;
}
