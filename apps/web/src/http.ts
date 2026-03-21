import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { hasAnyRole, PrincipalResolver, type ResolvedPrincipal } from "@agent-registry/auth";
import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  AgentNotFoundError,
  AgentVersionNotFoundError,
  KyselyAgentAdminDetailRepository,
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyHealthRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantMembershipLookup,
  KyselyTenantPolicyOverlayRepository,
  KyselyTenantRepository,
  type AgentRegistryDb,
} from "@agent-registry/db";

import {
  AgentDraftNotFoundError,
  AgentDraftRegistrationAuthorizationError,
  AgentDraftRegistrationService,
  AgentDraftRegistrationValidationError,
} from "../../api/src/modules/agents/service.js";
import {
  EnvironmentCatalogAuthorizationError,
  EnvironmentCatalogDuplicateError,
  EnvironmentCatalogValidationError,
  TenantEnvironmentCatalogService,
} from "../../api/src/modules/environments/service.js";
import {
  TenantPolicyOverlayAuthorizationError,
  TenantPolicyOverlayService,
} from "../../api/src/modules/overlays/service.js";
import {
  AgentVersionProbeTargetPolicyError,
  AgentVersionReviewAuthorizationError,
  AgentVersionReviewService,
  type AgentVersionReviewServiceOptions,
  AgentVersionReviewValidationError,
  InvalidVersionTransitionError,
} from "../../api/src/modules/review/service.js";
import { handleAssetRequest } from "./ui/assets.js";
import { renderStatusPage } from "./ui/document.js";
import { type ShellNavigationItem, writeAuthenticatedShell, writePublicShell } from "./ui/shell.js";

const sessionCookieName = "agent_registry_console_session";

class ConsoleAuthorizationError extends Error {}

class ConsoleValidationError extends Error {}

export interface WebRequestListenerOptions {
  config?: Pick<RegistryConfig, "deploymentMode" | "healthProbe" | "rawCardByteLimit">;
  db: AgentRegistryDb;
  reviewServiceOptions?: Pick<
    AgentVersionReviewServiceOptions,
    "enqueuePublicationProbe" | "resolveProbeHostname"
  >;
}

interface ConsoleSession {
  subjectId: string;
  tenantId: string;
}

interface TenantMembershipOption {
  roles: string[];
  subjectId: string;
}

interface TenantConsoleOption {
  displayName: string;
  memberships: TenantMembershipOption[];
  tenantId: string;
}

interface DashboardVersionLink {
  agentId: string;
  approvalState: string;
  displayName: string;
  versionId: string;
  versionSequence: number;
}

interface ReviewQueueEntry {
  agentId: string;
  displayName: string;
  submittedAt: string | null;
  versionId: string;
  versionSequence: number;
}

type AuthenticatedNavigationKey = "contextual" | "dashboard" | "drafts" | "environments" | "review";

type AuthenticatedPageId =
  | "agent-detail"
  | "dashboard"
  | "draft-registration"
  | "environments"
  | "review-queue"
  | "version-detail";

interface AuthenticatedPageOptions {
  body: string;
  contextualNavigationItem?: Omit<ShellNavigationItem, "current">;
  currentNavigationKey: AuthenticatedNavigationKey;
  pageId: AuthenticatedPageId;
  principal: ResolvedPrincipal;
  tenantLabel?: string;
  title: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPreformattedJson(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function formatSubmittedAtLabel(value: string | null): string {
  if (value === null) {
    return "Submitted for review";
  }

  const submittedAt = new Date(value);

  if (Number.isNaN(submittedAt.getTime())) {
    return `Submitted for review · ${value}`;
  }

  return `Submitted for review · ${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(submittedAt)} UTC`;
}

function buildAuthenticatedNavigation(
  principal: ResolvedPrincipal,
  currentNavigationKey: AuthenticatedNavigationKey,
  contextualNavigationItem?: Omit<ShellNavigationItem, "current">,
): ShellNavigationItem[] {
  const tenantId = encodeURIComponent(principal.tenantId);
  const items: ShellNavigationItem[] = [
    {
      current: currentNavigationKey === "dashboard",
      href: "/console",
      label: "Dashboard",
    },
  ];

  if (canPublish(principal)) {
    items.push({
      current: currentNavigationKey === "drafts",
      href: `/tenants/${tenantId}/drafts/new`,
      label: "New Draft",
    });
  }

  if (isTenantAdmin(principal)) {
    items.push(
      {
        current: currentNavigationKey === "environments",
        href: `/tenants/${tenantId}/environments`,
        label: "Environments",
      },
      {
        current: currentNavigationKey === "review",
        href: `/tenants/${tenantId}/review`,
        label: "Review",
      },
    );
  }

  if (contextualNavigationItem !== undefined) {
    items.push({
      ...contextualNavigationItem,
      current: currentNavigationKey === "contextual",
    });
  }

  return items;
}

function writeHtml(
  response: ServerResponse,
  statusCode: number,
  options: AuthenticatedPageOptions,
  headers: Record<string, string> = {},
): void {
  writeAuthenticatedShell(
    response,
    statusCode,
    {
      body: options.body,
      navigation: buildAuthenticatedNavigation(
        options.principal,
        options.currentNavigationKey,
        options.contextualNavigationItem,
      ),
      pageId: options.pageId,
      roles: options.principal.roles,
      subjectId: options.principal.subjectId,
      tenantId: options.principal.tenantId,
      tenantLabel: options.tenantLabel,
      title: options.title,
    },
    headers,
  );
}

function writeError(response: ServerResponse, statusCode: number, message: string): void {
  writePublicShell(
    response,
    statusCode,
    {
      body: renderStatusPage({
        linkHref: "/",
        linkLabel: "Return to sign-in",
        message,
        statusCode,
        title: "Console Error",
      }),
      pageId: "status",
      title: "Console Error",
    },
  );
}

function writeConsoleHomePage(
  response: ServerResponse,
  body: string,
): void {
  writePublicShell(
    response,
    200,
    {
      body,
      pageId: "sign-in",
      title: "Agent Registry",
    },
  );
}

function renderSetupPendingLanding(options: {
  detailBody: string;
  detailTitle: string;
  setupMessage: string;
}): string {
  return `<section class="console-public-card console-public-card--access stack" data-public-panel="access" id="registry-access">
    <div class="stack">
      <p class="console-kicker">Registry Access</p>
      <h2>Access pending initialization</h2>
      <p>Console access becomes available after the registry foundation is initialized.</p>
    </div>
    <div class="console-public-static-input">
      <span>Sign-in stays disabled while setup is incomplete.</span>
      <strong>Tenant and subject controls will appear here once bootstrap completes.</strong>
    </div>
  </section>
  <section class="console-public-card console-public-card--setup stack" data-public-panel="setup" id="setup-state">
    <div class="console-public-card__marker" aria-hidden="true">01</div>
    <div class="stack console-public-card__content">
      <p class="console-kicker">Setup State</p>
      <h2>Console Setup Pending</h2>
      <p>${escapeHtml(options.setupMessage)}</p>
      <div class="console-public-summary-grid">
        <article class="console-public-highlight">
          <p class="console-kicker">Registry Foundation</p>
          <h3>${escapeHtml(options.detailTitle)}</h3>
          <p>${escapeHtml(options.detailBody)}</p>
        </article>
        <article class="console-public-highlight">
          <p class="console-kicker">Next Step</p>
          <h3>Complete bootstrap</h3>
          <p>Initialize schema, tenants, and memberships before enabling console sign-in.</p>
        </article>
      </div>
    </div>
  </section>`;
}

function renderSignInLanding(options: {
  deploymentMode: "hosted" | "self-hosted";
  hostedTenantOptions: string;
  selfHostedTenant: TenantConsoleOption;
  visibleTenant: TenantConsoleOption;
}): string {
  const hasMemberships = options.visibleTenant.memberships.length > 0;
  const subjectOptions = hasMemberships
    ? options.visibleTenant.memberships
        .map(
          (membership) =>
            `<option value="${escapeHtml(membership.subjectId)}">${escapeHtml(membership.subjectId)} [${escapeHtml(membership.roles.join(", ") || "no roles")}]</option>`,
        )
        .join("")
    : `<option value="" disabled selected>No memberships available for ${escapeHtml(options.visibleTenant.displayName)}.</option>`;
  const deploymentModeLabel = options.deploymentMode === "hosted" ? "Hosted" : "Self-hosted";
  const deploymentModeSummary =
    options.deploymentMode === "hosted"
      ? "Hosted mode still drives tenant selection from the ?tenantId= query parameter."
      : "Single-tenant deployment keeps tenant scope collapsed to the hidden tenantId input.";
  const membershipSummary =
    options.visibleTenant.memberships.length === 1
      ? "1 seeded membership is ready for sign-in."
      : `${options.visibleTenant.memberships.length} seeded memberships are ready for sign-in.`;
  const currentFlowSummary = hasMemberships
    ? "Authenticate with a seeded subject to continue to the console."
    : "Add a tenant membership before sign-in becomes interactive.";

  return `<section class="console-public-card console-public-card--access stack" data-public-panel="access" id="registry-access">
    <div class="stack">
      <p class="console-kicker">Registry Access</p>
      <h2>${hasMemberships ? "Authenticate identity" : "Membership required"}</h2>
      <p>${
        hasMemberships
          ? "Select a tenant context and truthful subject membership to continue to the console."
          : `No memberships are configured for ${escapeHtml(options.visibleTenant.displayName)} yet.`
      }</p>
    </div>
    <form class="stack console-public-form" action="/session" method="post">
      ${
        options.deploymentMode === "self-hosted"
          ? `<div class="stack">
               <p class="console-kicker">Tenant Scope</p>
               <input type="hidden" name="tenantId" value="${escapeHtml(options.selfHostedTenant.tenantId)}" />
               <div class="console-public-static-input">
                 <span>Single-tenant deployment</span>
                 <strong>${escapeHtml(options.selfHostedTenant.displayName)} (${escapeHtml(options.selfHostedTenant.tenantId)})</strong>
               </div>
             </div>`
          : `<label>Tenant
               <select name="tenantId" onchange="window.location='/?tenantId='+encodeURIComponent(this.value)">
                 ${options.hostedTenantOptions}
               </select>
             </label>`
      }
      <label>Subject
        <select name="subjectId"${hasMemberships ? "" : ' disabled aria-disabled="true"'}>
          ${subjectOptions}
        </select>
      </label>
      ${
        hasMemberships
          ? ""
          : `<p class="meta">Add at least one tenant membership before signing in.</p>`
      }
      <button type="submit"${hasMemberships ? "" : ' disabled aria-disabled="true"'}>Authenticate Identity</button>
    </form>
  </section>
  <section class="console-public-card console-public-card--setup stack" data-public-panel="setup" id="setup-state">
    <div class="console-public-card__marker" aria-hidden="true">01</div>
    <div class="stack console-public-card__content">
      <p class="console-kicker">Setup State</p>
      <h2>${hasMemberships ? "Truthful sign-in state" : "Memberships pending"}</h2>
      <p>${
        hasMemberships
          ? "The landing page reflects current memberships while preserving the existing hosted and self-hosted sign-in paths."
          : `The selected tenant exists, but no sign-in memberships are available for ${escapeHtml(options.visibleTenant.displayName)}.`
      }</p>
      <div class="console-public-summary-grid">
        <article class="console-public-highlight">
          <p class="console-kicker">Deployment Mode</p>
          <h3>${deploymentModeLabel}</h3>
          <p>${deploymentModeSummary}</p>
        </article>
        <article class="console-public-highlight">
          <p class="console-kicker">Selected Tenant</p>
          <h3>${escapeHtml(options.visibleTenant.displayName)}</h3>
          <p>${escapeHtml(options.visibleTenant.tenantId)}</p>
        </article>
        <article class="console-public-highlight">
          <p class="console-kicker">Memberships</p>
          <h3>${escapeHtml(String(options.visibleTenant.memberships.length))}</h3>
          <p>${membershipSummary}</p>
        </article>
        <article class="console-public-highlight">
          <p class="console-kicker">Current Flow</p>
          <h3>${hasMemberships ? "Access ready" : "Awaiting memberships"}</h3>
          <p>${currentFlowSummary}</p>
        </article>
      </div>
    </div>
  </section>`;
}

function redirect(
  response: ServerResponse,
  location: string,
  cookies: string[] = [],
): void {
  response.writeHead(303, {
    location,
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
  });
  response.end();
}

function isTenantAdmin(principal: ResolvedPrincipal): boolean {
  return hasAnyRole(principal.roles, ["tenant-admin"]);
}

function canPublish(principal: ResolvedPrincipal): boolean {
  return hasAnyRole(principal.roles, ["publisher", "tenant-admin"]);
}

function encodeSession(session: ConsoleSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeSession(value: string): ConsoleSession | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed.subjectId !== "string" ||
      typeof parsed.tenantId !== "string"
    ) {
      return null;
    }

    return {
      subjectId: parsed.subjectId,
      tenantId: parsed.tenantId,
    };
  } catch {
    return null;
  }
}

function getCookie(request: IncomingMessage, name: string): string | null {
  const rawCookie = request.headers.cookie;

  if (!rawCookie) {
    return null;
  }

  for (const segment of rawCookie.split(";")) {
    const trimmed = segment.trim();
    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    if (trimmed.slice(0, separatorIndex) === name) {
      return trimmed.slice(separatorIndex + 1);
    }
  }

  return null;
}

function createSessionCookie(session: ConsoleSession): string {
  return `${sessionCookieName}=${encodeSession(session)}; Path=/; HttpOnly; SameSite=Lax`;
}

function createExpiredSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function getPathname(request: IncomingMessage): string {
  return getRequestUrl(request).pathname;
}

function createRequestForFormData(request: IncomingMessage): Request {
  const url = getRequestUrl(request);
  const method = request.method ?? "GET";
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }

    headers.set(name, value);
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(url, {
      headers,
      method,
    });
  }

  return new Request(url, {
    body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
    duplex: "half",
    headers,
    method,
  } as RequestInit & { duplex: "half" });
}

async function readFormData(request: IncomingMessage): Promise<FormData> {
  return createRequestForFormData(request).formData();
}

function readStringField(
  formData: FormData,
  fieldName: string,
  options: {
    fallback?: string;
    required?: boolean;
  } = {},
): string {
  const rawValue = formData.get(fieldName);

  if (rawValue === null) {
    if (options.required) {
      throw new ConsoleValidationError(`Field '${fieldName}' is required.`);
    }

    return options.fallback ?? "";
  }

  if (typeof rawValue !== "string") {
    throw new ConsoleValidationError(`Field '${fieldName}' must be a string.`);
  }

  const value = rawValue.trim();

  if (options.required && value === "") {
    throw new ConsoleValidationError(`Field '${fieldName}' is required.`);
  }

  return value === "" ? (options.fallback ?? "") : value;
}

function parseDelimitedStrings(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))];
}

function readJsonField<TValue>(formData: FormData, fieldName: string): TValue {
  const rawValue = readStringField(formData, fieldName, {
    required: true,
  });

  return JSON.parse(rawValue) as TValue;
}

function readDraftJsonField<TValue>(formData: FormData, fieldName: string): TValue {
  try {
    return readJsonField<TValue>(formData, fieldName);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AgentDraftRegistrationValidationError(
        `Field '${fieldName}' must be valid JSON.`,
      );
    }

    if (error instanceof Error) {
      throw new AgentDraftRegistrationValidationError(error.message);
    }

    throw error;
  }
}

async function readRawCardField(formData: FormData, fieldName: string): Promise<string> {
  const rawValue = formData.get(fieldName);

  if (rawValue === null) {
    throw new ConsoleValidationError(`Field '${fieldName}' is required.`);
  }

  if (typeof rawValue === "string") {
    return rawValue;
  }

  return rawValue.text();
}

async function loadTenantConsoleOptions(db: AgentRegistryDb): Promise<TenantConsoleOption[]> {
  const [tenants, memberships] = await Promise.all([
    db.selectFrom("tenants").select(["display_name", "tenant_id"]).orderBy("display_name").execute(),
    db
      .selectFrom("tenant_memberships")
      .select(["roles", "subject_id", "tenant_id"])
      .orderBy("tenant_id")
      .orderBy("subject_id")
      .execute(),
  ]);

  return tenants.map((tenant) => ({
    displayName: tenant.display_name,
    memberships: memberships
      .filter((membership) => membership.tenant_id === tenant.tenant_id)
      .map((membership) => ({
        roles: membership.roles,
        subjectId: membership.subject_id,
      })),
    tenantId: tenant.tenant_id,
  }));
}

function isMissingConsoleSchemaError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /relation "(tenant_memberships|tenants)" does not exist/.test(error.message);
}

async function resolvePrincipalFromSession(
  principalResolver: PrincipalResolver,
  request: IncomingMessage,
): Promise<ResolvedPrincipal | null> {
  const encodedSession = getCookie(request, sessionCookieName);

  if (encodedSession === null) {
    return null;
  }

  const session = decodeSession(encodedSession);

  if (session === null) {
    return null;
  }

  return principalResolver.resolve({
    auth: {
      subjectId: session.subjectId,
    },
    tenantId: session.tenantId,
  });
}

async function renderSignInPage(
  response: ServerResponse,
  db: AgentRegistryDb,
  deploymentMode: "hosted" | "self-hosted",
  selectedHostedTenantId?: string,
): Promise<void> {
  let tenants: TenantConsoleOption[];

  try {
    tenants = await loadTenantConsoleOptions(db);
  } catch (error) {
    if (isMissingConsoleSchemaError(error)) {
      writeConsoleHomePage(
        response,
        renderSetupPendingLanding({
          detailBody: "Run migrations before loading bootstrap tenants and memberships.",
          detailTitle: "Schema missing",
          setupMessage: "Run migrations and load bootstrap tenant data to enable console sign-in.",
        }),
      );
      return;
    }

    throw error;
  }

  if (tenants.length === 0) {
    writeConsoleHomePage(
      response,
      renderSetupPendingLanding({
        detailBody: "The schema is available, but no tenant memberships are bootstrapped yet.",
        detailTitle: "Bootstrap pending",
        setupMessage: "Bootstrap tenant and membership data to enable console sign-in.",
      }),
    );
    return;
  }

  const selfHostedTenant = tenants[0];
  const selectedHostedTenant =
    deploymentMode === "hosted"
      ? tenants.find((tenant) => tenant.tenantId === selectedHostedTenantId) ?? tenants[0]
      : selfHostedTenant;
  const hostedTenantOptions = tenants
    .map(
      (tenant) =>
        `<option value="${escapeHtml(tenant.tenantId)}"${tenant.tenantId === selectedHostedTenant.tenantId ? " selected" : ""}>${escapeHtml(tenant.displayName)} (${escapeHtml(tenant.tenantId)})</option>`,
    )
    .join("");
  const visibleTenant = deploymentMode === "hosted" ? selectedHostedTenant : selfHostedTenant;

  writeConsoleHomePage(
    response,
    renderSignInLanding({
      deploymentMode,
      hostedTenantOptions,
      selfHostedTenant,
      visibleTenant,
    }),
  );
}

async function loadTenantDisplayName(db: AgentRegistryDb, tenantId: string): Promise<string> {
  const tenant = await db
    .selectFrom("tenants")
    .select("display_name")
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();

  return tenant?.display_name ?? tenantId;
}

async function listDashboardVersions(
  db: AgentRegistryDb,
  principal: ResolvedPrincipal,
): Promise<DashboardVersionLink[]> {
  let query = db
    .selectFrom("agent_versions")
    .select([
      "agent_id",
      "approval_state",
      "display_name",
      "version_id",
      "version_sequence",
    ])
    .where("tenant_id", "=", principal.tenantId)
    .orderBy("version_sequence", "desc");

  if (!isTenantAdmin(principal)) {
    query = query.where("publisher_id", "=", principal.subjectId);
  }

  const rows = await query.execute();

  return rows.map((row) => ({
    agentId: row.agent_id,
    approvalState: row.approval_state,
    displayName: row.display_name,
    versionId: row.version_id,
    versionSequence: row.version_sequence,
  }));
}

async function listActiveAgents(
  db: AgentRegistryDb,
  tenantId: string,
): Promise<Array<{ agentId: string; displayName: string }>> {
  const rows = await db
    .selectFrom("agents")
    .select(["agent_id", "display_name"])
    .where("tenant_id", "=", tenantId)
    .where("active_version_id", "is not", null)
    .orderBy("display_name")
    .execute();

  return rows.map((row) => ({
    agentId: row.agent_id,
    displayName: row.display_name,
  }));
}

function renderDashboardVersions(
  tenantId: string,
  versions: DashboardVersionLink[],
): string {
  if (versions.length === 0) {
    return '<p class="dashboard-empty">No versions are visible for this identity.</p>';
  }

  return versions
    .map(
      (version) =>
        `<a class="dashboard-resource" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(version.agentId)}/versions/${encodeURIComponent(version.versionId)}">
          <div class="dashboard-resource__copy">
            <p class="console-kicker">Version v${escapeHtml(version.versionSequence)}</p>
            <h3>${escapeHtml(version.displayName)}</h3>
            <p class="dashboard-resource__meta">Approval state: ${escapeHtml(version.approvalState)}</p>
          </div>
          <span class="dashboard-state-pill">${escapeHtml(version.approvalState.replaceAll("_", " "))}</span>
        </a>`,
    )
    .join("");
}

function renderDashboardActiveAgents(
  tenantId: string,
  activeAgents: Array<{ agentId: string; displayName: string }>,
): string {
  if (activeAgents.length === 0) {
    return '<p class="dashboard-empty">No active approved agents yet.</p>';
  }

  return activeAgents
    .map(
      (agent) =>
        `<a class="dashboard-resource" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agent.agentId)}">
          <div class="dashboard-resource__copy">
            <p class="console-kicker">Active Agent</p>
            <h3>${escapeHtml(agent.displayName)}</h3>
            <p class="dashboard-resource__meta">Open publication detail and overlay controls.</p>
          </div>
          <span class="dashboard-resource__action">Open</span>
        </a>`,
    )
    .join("");
}

async function renderDashboard(
  response: ServerResponse,
  db: AgentRegistryDb,
  principal: ResolvedPrincipal,
): Promise<void> {
  const [tenantDisplayName, versions, activeAgents] = await Promise.all([
    loadTenantDisplayName(db, principal.tenantId),
    listDashboardVersions(db, principal),
    isTenantAdmin(principal) ? listActiveAgents(db, principal.tenantId) : Promise.resolve([]),
  ]);
  const encodedTenantId = encodeURIComponent(principal.tenantId);
  const roleSummary = principal.roles.join(", ") || "none";
  const pendingReviewCount = versions.filter(
    (version) => version.approvalState === "pending_review",
  ).length;
  const primaryActionPanel = canPublish(principal)
    ? `<a class="dashboard-primary-link" href="/tenants/${encodedTenantId}/drafts/new">New Draft Registration</a>`
    : '<p class="dashboard-empty">No publishing actions are available for this identity.</p>';
  const versionsPanelClass = isTenantAdmin(principal)
    ? "dashboard-panel dashboard-panel--versions"
    : "dashboard-panel dashboard-panel--versions dashboard-panel--versions-wide";

  writeHtml(
    response,
    200,
    {
      body: `<section class="dashboard-grid" aria-label="Console dashboard">
        <section class="dashboard-panel dashboard-panel--hero">
          <p class="console-kicker">System Overview</p>
          <h1>System Overview</h1>
          <p class="dashboard-lead">Welcome back, <strong>${escapeHtml(principal.subjectId)}</strong>. You are working in the <strong>${escapeHtml(tenantDisplayName)}</strong> workspace.</p>
          <div class="dashboard-stat-list">
            <div class="dashboard-stat">
              <span class="dashboard-stat__label">Visible Versions</span>
              <strong class="dashboard-stat__value">${escapeHtml(versions.length)}</strong>
            </div>
            <div class="dashboard-stat">
              <span class="dashboard-stat__label">${isTenantAdmin(principal) ? "Active Agents" : "Signed-In Role"}</span>
              <strong class="dashboard-stat__value">${escapeHtml(isTenantAdmin(principal) ? activeAgents.length : roleSummary)}</strong>
            </div>
          </div>
        </section>
        <section class="dashboard-panel dashboard-panel--context">
          <p class="console-kicker">Identity</p>
          <h2>Tenant Context</h2>
          <dl class="dashboard-context-list">
            <div>
              <dt>Tenant</dt>
              <dd>${escapeHtml(tenantDisplayName)} (${escapeHtml(principal.tenantId)})</dd>
            </div>
            <div>
              <dt>Signed-In Subject</dt>
              <dd>${escapeHtml(principal.subjectId)}</dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd>${escapeHtml(roleSummary)}</dd>
            </div>
          </dl>
        </section>
        <section class="dashboard-panel dashboard-panel--primary">
          <p class="console-kicker">Publishing Access</p>
          <h2>New Draft Registration</h2>
          <p class="dashboard-muted">Register a new draft with the current multipart contract and publication flow.</p>
          ${primaryActionPanel}
        </section>
        ${
          isTenantAdmin(principal)
            ? `<a class="dashboard-panel dashboard-panel--navigation" href="/tenants/${encodedTenantId}/environments">
                 <p class="console-kicker">Tenant Administration</p>
                 <h2>Environment Management</h2>
                 <p class="dashboard-muted">Manage configured environments and add tenant targets without leaving the console shell.</p>
               </a>
               <a class="dashboard-panel dashboard-panel--navigation" href="/tenants/${encodedTenantId}/review">
                 <p class="console-kicker">Decision Queue</p>
                 <h2>Review Queue</h2>
                 <p class="dashboard-muted">${escapeHtml(pendingReviewCount)} pending version${pendingReviewCount === 1 ? "" : "s"} currently require a review decision.</p>
               </a>`
            : ""
        }
        <section class="${versionsPanelClass}">
          <div class="dashboard-panel__header">
            <div>
              <p class="console-kicker">Current Inventory</p>
              <h2>Visible Versions</h2>
            </div>
            <p class="dashboard-muted">${escapeHtml(versions.length)} version${versions.length === 1 ? "" : "s"} visible to this identity.</p>
          </div>
          <div class="dashboard-resource-list">
            ${renderDashboardVersions(principal.tenantId, versions)}
          </div>
        </section>
        ${
          isTenantAdmin(principal)
            ? `<section class="dashboard-panel dashboard-panel--agents">
                 <div class="dashboard-panel__header">
                   <div>
                     <p class="console-kicker">Published Fleet</p>
                     <h2>Active Agents</h2>
                   </div>
                   <p class="dashboard-muted">${escapeHtml(activeAgents.length)} active agent${activeAgents.length === 1 ? "" : "s"} currently have approved publications.</p>
                 </div>
                 <div class="dashboard-resource-list">
                   ${renderDashboardActiveAgents(principal.tenantId, activeAgents)}
                 </div>
               </section>`
            : ""
        }
      </section>`,
      currentNavigationKey: "dashboard",
      pageId: "dashboard",
      principal,
      tenantLabel: tenantDisplayName,
      title: "Console Dashboard",
    },
  );
}

async function requirePrincipal(
  response: ServerResponse,
  principalResolver: PrincipalResolver,
  request: IncomingMessage,
): Promise<ResolvedPrincipal | null> {
  try {
    const principal = await resolvePrincipalFromSession(principalResolver, request);

    if (principal === null) {
      redirect(response, "/", [createExpiredSessionCookie()]);
      return null;
    }

    return principal;
  } catch {
    redirect(response, "/", [createExpiredSessionCookie()]);
    return null;
  }
}

function assertTenantAccess(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new ConsoleAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertTenantAdminAccess(principal: ResolvedPrincipal): void {
  if (!isTenantAdmin(principal)) {
    throw new ConsoleAuthorizationError("Tenant admin role is required to access this page.");
  }
}

function renderEnvironmentForm(tenantId: string): string {
  return `<form class="environment-create__form" action="/tenants/${encodeURIComponent(tenantId)}/environments" method="post">
    <label>Environment key
      <input name="environmentKey" placeholder="qa" />
    </label>
    <p class="environment-create__hint">Use a stable key such as <code>qa</code> or <code>preview</code>.</p>
    <button type="submit">Create Environment</button>
  </form>`;
}

async function renderEnvironmentPage(
  response: ServerResponse,
  environmentService: TenantEnvironmentCatalogService,
  principal: ResolvedPrincipal,
  tenantId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);
  assertTenantAdminAccess(principal);

  const environments = await environmentService.listEnvironments(principal, tenantId);
  const environmentCount = environments.environments.length;
  const environmentCatalog =
    environmentCount === 0
      ? `<article class="environment-entry environment-entry--empty">
          <div class="stack">
            <p class="environment-entry__order">Catalog Empty</p>
            <h3>No environments configured yet</h3>
            <p class="meta">Use the creation panel to add the first publication target for this tenant.</p>
          </div>
        </article>`
      : environments.environments
          .map(
            (environment, index) => `
              <article class="environment-entry">
                <div class="environment-entry__body stack">
                  <p class="environment-entry__order">Environment ${String(index + 1).padStart(2, "0")}</p>
                  <div class="stack">
                    <h3>${escapeHtml(environment.environmentKey)}</h3>
                    <p class="meta">Available for tenant publication targeting and agent overlay controls.</p>
                  </div>
                </div>
                <div class="environment-entry__meta">
                  <span class="pill">Publication Target</span>
                  <span class="pill">Overlay Controls</span>
                </div>
              </article>`,
          )
          .join("");

  writeHtml(
    response,
    200,
    {
      body: `<section class="environment-page">
      <section class="environment-hero card">
        <div class="environment-hero__copy stack">
          <p class="console-kicker">Tenant Settings</p>
          <h1>Environment Management</h1>
          <p class="environment-hero__lede">Curate the tenant environment catalog used by draft registration, review, and overlay controls.</p>
          <div class="environment-hero__meta">
            <a href="/console">Return to Dashboard</a>
            <span class="pill">Tenant ${escapeHtml(tenantId)}</span>
          </div>
        </div>
        <div class="environment-hero__actions">
          <a class="environment-hero__cta" href="#environment-creation-panel">Create Environment</a>
        </div>
      </section>
      <section class="environment-overview" aria-label="Environment overview">
        <article class="environment-overview__card card stack">
          <p class="console-kicker">Configured</p>
          <p class="environment-overview__value">${environmentCount}</p>
          <p class="meta">${environmentCount === 1 ? "publication target" : "publication targets"} currently available for tenant drafts.</p>
        </article>
        <article class="environment-overview__card card stack">
          <p class="console-kicker">Tenant Scope</p>
          <p class="environment-overview__title">${escapeHtml(tenantId)}</p>
          <p class="meta">Changes stay scoped to this tenant and preserve the current redirect flow.</p>
        </article>
        <article class="environment-overview__card card stack">
          <p class="console-kicker">Access</p>
          <p class="environment-overview__title">Tenant Admin</p>
          <p class="meta">Environment creation stays limited to administrators. Publishers still receive the existing 403 response.</p>
        </article>
      </section>
      <section class="environment-surfaces">
        <div class="environment-catalog card stack">
          <div class="environment-section-heading stack">
            <p class="console-kicker">Primary Surface</p>
            <h2>Environment Catalog</h2>
            <p class="meta">Configured environments are the publish targets available across draft registration, review, and overlay workflows.</p>
          </div>
          <div class="environment-catalog__list">
            ${environmentCatalog}
          </div>
        </div>
        <aside class="environment-create card stack" id="environment-creation-panel">
          <div class="environment-section-heading stack">
            <p class="console-kicker">Secondary Panel</p>
            <h2>Create Environment</h2>
            <p class="meta">Add a new environment key using the existing catalog route. The created key returns here after redirect and becomes available to publication forms.</p>
          </div>
          ${renderEnvironmentForm(tenantId)}
        </aside>
      </section>
    </section>`,
      currentNavigationKey: "environments",
      pageId: "environments",
      principal,
      title: "Environment Management",
    },
  );
}

async function createEnvironmentFromForm(
  response: ServerResponse,
  request: IncomingMessage,
  environmentService: TenantEnvironmentCatalogService,
  principal: ResolvedPrincipal,
  tenantId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);
  assertTenantAdminAccess(principal);

  const formData = await readFormData(request);

  await environmentService.createEnvironment(principal, tenantId, {
    environmentKey: readStringField(formData, "environmentKey", {
      required: true,
    }),
  });
  redirect(response, `/tenants/${encodeURIComponent(tenantId)}/environments`);
}

async function renderDraftFormPage(
  response: ServerResponse,
  db: AgentRegistryDb,
  environmentService: TenantEnvironmentCatalogService,
  principal: ResolvedPrincipal,
  tenantId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);

  if (!canPublish(principal)) {
    throw new ConsoleAuthorizationError(
      "Publisher role is required to create draft agent registrations.",
    );
  }

  const environments = await environmentService.listEnvironments(principal, tenantId);
  const publicationFields = environments.environments
    .map(
      (environment) =>
        `<section class="draft-publication-panel card" data-draft-publication-panel="${escapeHtml(environment.environmentKey)}">
          <div class="draft-publication-panel__header">
            <div class="draft-publication-panel__summary">
              <p class="console-kicker">Environment publication</p>
              <h3>${escapeHtml(environment.environmentKey)}</h3>
              <p class="meta">Configure rollout endpoints and attach the truthful raw card used for ${escapeHtml(environment.environmentKey)}.</p>
            </div>
            <label class="draft-toggle">
              <input type="checkbox" name="publication:${escapeHtml(environment.environmentKey)}:enabled" />
              <span>Enable publication</span>
            </label>
          </div>
          <div class="draft-publication-panel__grid">
            <label class="draft-field">Health endpoint URL
              <input name="publication:${escapeHtml(environment.environmentKey)}:healthEndpointUrl" placeholder="https://${escapeHtml(environment.environmentKey)}.health.example.com/status" />
            </label>
            <label class="draft-field">Optional invocation endpoint override
              <input name="publication:${escapeHtml(environment.environmentKey)}:invocationEndpoint" placeholder="https://agent.example.com/invoke" />
            </label>
            <label class="draft-field draft-field--full">Raw card upload
              <input class="draft-file-input" type="file" name="publication:${escapeHtml(environment.environmentKey)}:rawCard" />
              <span class="draft-field__hint">Upload the raw card JSON artifact for this environment publication.</span>
            </label>
          </div>
        </section>`,
    )
    .join("");

  writeHtml(
    response,
    200,
    {
      body: `<section class="draft-hero card">
      <div class="draft-hero__copy">
        <p class="console-kicker">Draft Composition</p>
        <h1>New Draft Registration</h1>
        <p class="meta">Create one immutable version snapshot with shared metadata and multiple environment-specific cards.</p>
        <p><a href="/console">Back to dashboard</a></p>
      </div>
      <aside class="draft-hero__note stack">
        <p class="console-kicker">Submission Pattern</p>
        <h2>One multipart payload, grouped for review.</h2>
        <p class="meta">General metadata, shared contracts, and per-environment publication inputs are organized into dedicated technical panels without changing how the draft is posted.</p>
      </aside>
    </section>
    <form class="draft-form" data-draft-form="true" action="/tenants/${encodeURIComponent(tenantId)}/drafts" method="post" enctype="multipart/form-data">
      <section class="draft-section card" data-draft-section="general-metadata">
        <div class="draft-section__header">
          <div class="draft-section__copy">
            <p class="console-kicker">General Metadata</p>
            <h2>General Metadata</h2>
            <p class="meta">Define the version identity, editorial summary, and shared access requirements used across every publication.</p>
          </div>
          <span class="pill">Required</span>
        </div>
        <div class="draft-grid draft-grid--metadata">
          <label class="draft-field">Version label
            <input name="versionLabel" placeholder="v1" />
          </label>
          <label class="draft-field">Display name
            <input name="displayName" placeholder="Case Resolver" />
          </label>
          <label class="draft-field draft-field--full">Summary
            <textarea name="summary" rows="5" placeholder="Handles support case routing."></textarea>
          </label>
          <label class="draft-field">Capabilities
            <textarea name="capabilities" rows="4" placeholder="shared-capability, case-routing"></textarea>
          </label>
          <label class="draft-field">Tags
            <textarea name="tags" rows="3" placeholder="shared-tag, routing"></textarea>
          </label>
          <label class="draft-field">Required roles
            <textarea name="requiredRoles" rows="3" placeholder="support-agent"></textarea>
          </label>
          <label class="draft-field">Required scopes
            <textarea name="requiredScopes" rows="3" placeholder="tickets.read, tickets.write"></textarea>
          </label>
        </div>
      </section>
      <section class="draft-section card" data-draft-section="shared-contracts">
        <div class="draft-section__header">
          <div class="draft-section__copy">
            <p class="console-kicker">Shared Contracts</p>
            <h2>Shared Contracts</h2>
            <p class="meta">Keep reusable request constraints readable, even when the JSON payloads are long or reviewed on narrower screens.</p>
          </div>
        </div>
        <div class="draft-grid draft-grid--contracts">
          <label class="draft-field">Header contract JSON
            <textarea class="draft-code-input" name="headerContract" rows="10" spellcheck="false" wrap="off">[
  {
    "name": "X-User-Id",
    "required": true,
    "source": "user.id",
    "description": "Identifies the calling user."
  }
]</textarea>
          </label>
          <label class="draft-field">Context contract JSON
            <textarea class="draft-code-input" name="contextContract" rows="10" spellcheck="false" wrap="off">[
  {
    "key": "client_id",
    "required": true,
    "type": "string",
    "description": "Selects the client partition.",
    "example": "client-123"
  }
]</textarea>
          </label>
        </div>
      </section>
      <section class="draft-section card" data-draft-section="environment-publications">
        <div class="draft-section__header">
          <div class="draft-section__copy">
            <p class="console-kicker">Environment Publications</p>
            <h2>Environment Publications</h2>
            <p class="meta">Each environment keeps its own publication toggle, endpoint configuration, and raw card upload inside a dedicated technical panel.</p>
          </div>
        </div>
        <div class="draft-publications">
          ${publicationFields}
        </div>
      </section>
      <section class="draft-action-footer card" data-draft-action-footer="true">
        <div class="draft-action-footer__copy">
          <p class="console-kicker">Action Footer</p>
          <h2>Ready to create this immutable snapshot?</h2>
          <p class="meta">This keeps the current multipart form behavior and exact field names while presenting the payload in the same editorial system as the rest of the console.</p>
        </div>
        <div class="draft-action-footer__actions">
          <a class="pill" href="/console">Back to dashboard</a>
          <button type="submit">Create Draft</button>
        </div>
      </section>
    </form>`,
      currentNavigationKey: "drafts",
      pageId: "draft-registration",
      principal,
      title: "New Draft Registration",
    },
  );
}

async function createDraftFromForm(
  response: ServerResponse,
  request: IncomingMessage,
  environmentService: TenantEnvironmentCatalogService,
  draftService: AgentDraftRegistrationService,
  principal: ResolvedPrincipal,
  tenantId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);

  if (!canPublish(principal)) {
    throw new ConsoleAuthorizationError(
      "Publisher role is required to create draft agent registrations.",
    );
  }

  const [formData, environments] = await Promise.all([
    readFormData(request),
    environmentService.listEnvironments(principal, tenantId),
  ]);

  let draftInput: Parameters<AgentDraftRegistrationService["createDraftAgent"]>[2];

  try {
    const publications = [];

    for (const environment of environments.environments) {
      const prefix = `publication:${environment.environmentKey}:`;

      if (formData.get(`${prefix}enabled`) === null) {
        continue;
      }

      const invocationEndpoint = readStringField(formData, `${prefix}invocationEndpoint`);

      publications.push({
        environmentKey: environment.environmentKey,
        healthEndpointUrl: readStringField(formData, `${prefix}healthEndpointUrl`, {
          required: true,
        }),
        invocationEndpoint: invocationEndpoint === "" ? undefined : invocationEndpoint,
        rawCard: await readRawCardField(formData, `${prefix}rawCard`),
      });
    }

    draftInput = {
      capabilities: parseDelimitedStrings(
        readStringField(formData, "capabilities", { required: true }),
      ),
      contextContract: readDraftJsonField(formData, "contextContract"),
      displayName: readStringField(formData, "displayName", {
        required: true,
      }),
      headerContract: readDraftJsonField(formData, "headerContract"),
      publications,
      requiredRoles: parseDelimitedStrings(
        readStringField(formData, "requiredRoles", { fallback: "" }),
      ),
      requiredScopes: parseDelimitedStrings(
        readStringField(formData, "requiredScopes", { fallback: "" }),
      ),
      summary: readStringField(formData, "summary", {
        required: true,
      }),
      tags: parseDelimitedStrings(readStringField(formData, "tags", { fallback: "" })),
      versionLabel: readStringField(formData, "versionLabel", {
        required: true,
      }),
    };
  } catch (error) {
    if (error instanceof AgentDraftRegistrationValidationError) {
      throw error;
    }

    if (error instanceof Error) {
      throw new AgentDraftRegistrationValidationError(error.message);
    }

    throw error;
  }

  const draft = await draftService.createDraftAgent(principal, tenantId, draftInput);

  redirect(
    response,
    `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(draft.agentId)}/versions/${encodeURIComponent(draft.versionId)}`,
  );
}

async function listReviewQueue(
  db: AgentRegistryDb,
  tenantId: string,
): Promise<ReviewQueueEntry[]> {
  const rows = await db
    .selectFrom("agent_versions")
    .select(["agent_id", "display_name", "submitted_at", "version_id", "version_sequence"])
    .where("tenant_id", "=", tenantId)
    .where("approval_state", "=", "pending_review")
    .orderBy("submitted_at", "desc")
    .orderBy("version_sequence", "desc")
    .execute();

  return rows.map((row) => ({
    agentId: row.agent_id,
    displayName: row.display_name,
    submittedAt: row.submitted_at,
    versionId: row.version_id,
    versionSequence: row.version_sequence,
  }));
}

async function renderReviewQueuePage(
  response: ServerResponse,
  db: AgentRegistryDb,
  principal: ResolvedPrincipal,
  tenantId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);
  assertTenantAdminAccess(principal);

  const [tenantDisplayName, queue] = await Promise.all([
    loadTenantDisplayName(db, tenantId),
    listReviewQueue(db, tenantId),
  ]);

  writeHtml(
    response,
    200,
    {
      body: `<section class="review-queue stack">
      <header class="review-queue__hero card">
        <div class="review-queue__hero-copy stack">
          <p class="console-kicker">Validation Authority</p>
          <h1>Review Queue</h1>
          <p class="review-queue__hero-summary-copy">Decision queue for submitted versions in ${escapeHtml(tenantDisplayName)}. Inspect each version detail, then approve or reject without leaving the queue.</p>
        </div>
        <div class="review-queue__hero-metric">
          <p class="console-kicker">Awaiting decision</p>
          <p class="review-queue__hero-count">${queue.length}</p>
          <p class="review-queue__hero-caption">${queue.length === 1 ? "version needs review" : "versions need review"}</p>
        </div>
      </header>
      ${
        queue.length === 0
          ? `<section class="review-queue__empty card stack">
               <p class="console-kicker">Queue Clear</p>
               <h2>No versions are awaiting review.</h2>
               <p>Submitted versions will appear here as soon as a publisher hands them off for tenant-admin approval.</p>
             </section>`
          : `<ol class="review-queue__list" aria-label="Pending review decisions">
          ${queue
              .map(
                (entry) => {
                  const versionDetailPath = `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}`;
                  const rejectReasonId = `review-reject-reason-${entry.agentId}-${entry.versionId}`;

                  return `<li class="review-queue__row card" data-review-entry="${escapeHtml(`${entry.agentId}:${entry.versionId}`)}">
                    <div class="review-queue__row-main stack">
                      <div class="review-queue__row-heading">
                        <div class="stack">
                          <p class="console-kicker">Pending review</p>
                          <div class="review-queue__title-group">
                            <h2>${escapeHtml(entry.displayName)}</h2>
                            <span class="pill review-queue__version">Version ${entry.versionSequence}</span>
                          </div>
                        </div>
                        <p class="review-queue__meta">
                          <time datetime="${entry.submittedAt === null ? "" : escapeHtml(entry.submittedAt)}">${escapeHtml(formatSubmittedAtLabel(entry.submittedAt))}</time>
                        </p>
                      </div>
                      <a class="pill review-queue__inspect" href="${versionDetailPath}">Inspect version detail</a>
                    </div>
                    <div class="review-queue__actions">
                      <form class="review-queue__approve" action="${versionDetailPath}/approve" method="post">
                        <button type="submit">Approve</button>
                      </form>
                      <form class="review-queue__reject" action="${versionDetailPath}/reject" method="post">
                        <label class="review-queue__label" for="${rejectReasonId}">Reject reason</label>
                        <textarea id="${rejectReasonId}" name="reason" required placeholder="Needs clearer scopes."></textarea>
                        <button class="button-secondary" type="submit">Reject</button>
                      </form>
                    </div>
                  </li>`;
                },
              )
              .join("")}
          </ol>`
      }
    </section>`,
      currentNavigationKey: "review",
      pageId: "review-queue",
      principal,
      tenantLabel: tenantDisplayName,
      title: "Review Queue",
    },
  );
}

async function renderVersionDetailPage(
  response: ServerResponse,
  adminRepository: KyselyAgentAdminDetailRepository,
  healthRepository: KyselyHealthRepository,
  principal: ResolvedPrincipal,
  tenantId: string,
  agentId: string,
  versionId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);

  if (!canPublish(principal) && !isTenantAdmin(principal)) {
    throw new ConsoleAuthorizationError(
      "Publisher or tenant admin role is required to view version detail.",
    );
  }

  const detail = await adminRepository.getVersionDetail(tenantId, agentId, versionId);

  if (!isTenantAdmin(principal) && detail.publisherId !== principal.subjectId) {
    throw new ConsoleAuthorizationError(
      "Publishers may only view version details for versions they own.",
    );
  }

  const healthDetails =
    isTenantAdmin(principal) && detail.approvalState === "approved"
      ? await Promise.all(
          detail.publications.map(async (publication) => ({
            detail: await healthRepository.getPublicationHealth(
              tenantId,
              agentId,
              versionId,
              publication.environmentKey,
            ),
            environmentKey: publication.environmentKey,
          })),
        )
      : [];

  const healthByEnvironment = new Map(
    healthDetails.map((entry) => [entry.environmentKey, entry.detail]),
  );
  const stateDescriptions = {
    approved:
      "Approved versions preserve the full dossier, including admin-only telemetry and recorded health history.",
    draft:
      "Draft versions stay editable through the existing submission flow while surfacing the current technical contract.",
    pending_review:
      "Pending versions are ready for tenant-admin review without introducing unsupported controls or proxy workflow steps.",
    rejected:
      "Rejected versions keep the stored rejection reason and historical review data without reopening unsupported actions.",
  } satisfies Record<"approved" | "draft" | "pending_review" | "rejected", string>;
  const approvalTone =
    detail.approvalState === "approved"
      ? "accent"
      : detail.approvalState === "rejected"
        ? "alert"
        : detail.approvalState === "pending_review"
          ? "neutral"
          : "muted";
  const contractSummaryMarkup = [
    {
      label: "Header Fields",
      meta: "request boundary",
      value: String(detail.headerContract.length),
    },
    {
      label: "Context Keys",
      meta: "execution context",
      value: String(detail.contextContract.length),
    },
    {
      label: "Publication Targets",
      meta: "environment routes",
      value: String(detail.publications.length),
    },
  ]
    .map(
      (item) => `<article class="version-detail-contract-card">
        <p class="console-kicker">${escapeHtml(item.label)}</p>
        <strong>${escapeHtml(item.value)}</strong>
        <p class="version-detail-note">${escapeHtml(item.meta)}</p>
      </article>`,
    )
    .join("");
  const versionManifest = {
    agentId: detail.agentId,
    approvalState: detail.approvalState,
    cardProfileId: detail.cardProfileId,
    capabilities: detail.capabilities,
    contextContract: detail.contextContract,
    displayName: detail.displayName,
    headerContract: detail.headerContract,
    publications: detail.publications.map((publication) => ({
      environmentKey: publication.environmentKey,
      healthEndpointUrl: publication.healthEndpointUrl,
      healthStatus: publication.healthStatus,
      invocationEndpoint: publication.invocationEndpoint,
    })),
    publisherId: detail.publisherId,
    requiredRoles: detail.requiredRoles,
    requiredScopes: detail.requiredScopes,
    tags: detail.tags,
    versionId: detail.versionId,
    versionLabel: detail.versionLabel,
    versionSequence: detail.versionSequence,
  };
  const publicationMarkup = detail.publications
    .map((publication) => {
      const health = healthByEnvironment.get(publication.environmentKey);

      return `<article class="card stack version-detail-publication-card">
        <div class="version-detail-publication-card__header">
          <div class="stack">
            <p class="console-kicker">Environment Publication</p>
            <h3>Environment: ${escapeHtml(publication.environmentKey)}</h3>
          </div>
          ${renderVersionDetailPill(
            `Health ${publication.healthStatus ?? "unknown"}`,
            publication.healthStatus === "healthy" ? "accent" : "neutral",
          )}
        </div>
        <p class="version-detail-note">
          Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code>
        </p>
        <p class="version-detail-note">
          Invocation endpoint: <code>${escapeHtml(publication.invocationEndpoint ?? "none")}</code>
        </p>
        <div class="version-detail-code-grid">
          <article class="version-detail-code-panel stack">
            <h3>Normalized Metadata</h3>
            ${renderPreformattedJson(publication.normalizedMetadata)}
          </article>
          <article class="version-detail-code-panel stack">
            <h3>Raw Card</h3>
            <pre>${escapeHtml(publication.rawCard)}</pre>
          </article>
        </div>
        ${
          isTenantAdmin(principal)
            ? `<h3>Advisory Telemetry</h3>
               ${
                 publication.telemetry.length === 0
                   ? "<p>No advisory telemetry submitted.</p>"
                   : publication.telemetry
                       .map(
                          (telemetry) =>
                            `<article class="version-detail-timeline__item stack">
                             <p class="console-kicker">${escapeHtml(telemetry.windowStartedAt)} to ${escapeHtml(telemetry.windowEndedAt)}</p>
                             <p>Invocation count: ${telemetry.invocationCount}</p>
                             <p>Success count: ${telemetry.successCount}</p>
                             <p>Error count: ${telemetry.errorCount}</p>
                             <p>p95 latency: ${telemetry.p95LatencyMs ?? "n/a"}</p>
                           </article>`,
                        )
                       .join("")
               }`
            : ""
        }
        ${
          health === undefined
            ? ""
            : `<h3>Health History</h3>
               ${
                 health.history.length === 0
                   ? "<p>No probes recorded yet.</p>"
                   : health.history
                       .map(
                          (entry) =>
                            `<article class="version-detail-timeline__item stack">
                              <p class="console-kicker">${escapeHtml(entry.checkedAt)}</p>
                              <p>Status ${entry.statusCode === null ? "n/a" : String(entry.statusCode)}</p>
                              ${
                                entry.error === null
                                  ? ""
                                  : `<p class="version-detail-note">Error ${escapeHtml(entry.error)}</p>`
                              }
                            </article>`,
                        )
                       .join("")
               }`
        }
      </article>`;
    })
    .join("");
  const actions = [];
  const encodedTenantId = encodeURIComponent(tenantId);
  const encodedAgentId = encodeURIComponent(agentId);
  const encodedVersionId = encodeURIComponent(versionId);

  if (detail.approvalState === "draft" && canPublish(principal)) {
    actions.push(
      `<form action="/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}/submit" method="post">
         <button type="submit">Submit for Review</button>
       </form>`,
    );
  }

  if (detail.approvalState === "pending_review" && isTenantAdmin(principal)) {
    actions.push(
      `<form action="/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}/approve" method="post">
         <button type="submit">Approve</button>
       </form>`,
    );
    actions.push(
      `<form class="stack" action="/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}/reject" method="post">
         <label>Reject reason
           <input name="reason" placeholder="Needs clearer scopes." />
         </label>
         <button class="button-secondary" type="submit">Reject</button>
       </form>`,
    );
  }
  const heroLinks = [
    `<a class="pill version-detail-pill version-detail-pill--muted" href="/console">Back to dashboard</a>`,
  ];

  if (detail.active) {
    heroLinks.push(
      `<a class="pill version-detail-pill version-detail-pill--accent" href="/tenants/${encodedTenantId}/agents/${encodedAgentId}">Open active agent detail</a>`,
    );
  }

  writeHtml(
    response,
    200,
    {
      body: `<section class="version-detail-page stack" data-version-detail-view="dossier">
        <section class="card version-detail-hero" data-version-detail-section="hero">
          <div class="version-detail-hero__copy stack">
            <div class="stack">
              <p class="console-kicker">Current Publication Status</p>
              <div class="version-detail-chip-row">
                <span class="version-detail-pulse" aria-hidden="true"></span>
                ${renderVersionDetailPill(formatStatusLabel(detail.approvalState), approvalTone)}
                ${renderVersionDetailPill(`Version ${detail.versionSequence}`, "neutral")}
                ${
                  detail.active
                    ? renderVersionDetailPill("Active release", "accent")
                    : renderVersionDetailPill("Historical record", "muted")
                }
              </div>
            </div>
            <h1>${escapeHtml(detail.displayName)}</h1>
            <p class="version-detail-hero__lede">${escapeHtml(detail.summary)}</p>
            <p>Approval state: ${escapeHtml(detail.approvalState)}</p>
          </div>
          <div class="version-detail-hero__aside stack">
            <div class="version-detail-summary-grid">
              <article class="version-detail-summary-card">
                <p class="console-kicker">Version Label</p>
                <h2>${escapeHtml(detail.versionLabel)}</h2>
              </article>
              <article class="version-detail-summary-card">
                <p class="console-kicker">Sequence</p>
                <h2>${String(detail.versionSequence)}</h2>
              </article>
              <article class="version-detail-summary-card">
                <p class="console-kicker">Environment Count</p>
                <h2>${String(detail.publications.length)}</h2>
              </article>
              <article class="version-detail-summary-card">
                <p class="console-kicker">Card Profile</p>
                <h2>${escapeHtml(detail.cardProfileId)}</h2>
              </article>
            </div>
            <div class="version-detail-link-row">
              ${heroLinks.join("")}
            </div>
          </div>
        </section>
        <section class="version-detail-layout">
          <div class="version-detail-main">
            <section class="card stack version-detail-section" data-version-detail-section="contracts">
              <div class="version-detail-section__header stack">
                <p class="console-kicker">Publication Contracts</p>
                <h2>Publication Contracts</h2>
                <p>Truthful contract counts and the stored header and context requirements for this version.</p>
              </div>
              <div class="version-detail-contract-grid">
                ${contractSummaryMarkup}
              </div>
              <div class="version-detail-code-grid">
                <article class="version-detail-code-panel stack">
                  <h3>Header Contract</h3>
                  ${renderPreformattedJson(detail.headerContract)}
                </article>
                <article class="version-detail-code-panel stack">
                  <h3>Context Contract</h3>
                  ${renderPreformattedJson(detail.contextContract)}
                </article>
              </div>
            </section>
            <section class="card stack version-detail-section version-detail-manifest-section" data-version-detail-section="manifest">
              <div class="version-detail-section__header stack">
                <p class="console-kicker">Technical Manifest</p>
                <h2>Technical Manifest</h2>
                <p>The technical dossier records only the version metadata, scope, and publication routes the registry actually stores.</p>
              </div>
              <article class="version-detail-manifest-panel stack">
                ${renderPreformattedJson(versionManifest)}
              </article>
            </section>
            <section class="stack version-detail-section" data-version-detail-section="publications">
              <div class="version-detail-section__header stack">
                <p class="console-kicker">Environment Publications</p>
                <h2>Environment Publications</h2>
                <p>Each environment panel keeps the raw card, normalized metadata, health surface, and admin-only diagnostics attached to the current route.</p>
              </div>
              <div class="version-detail-publication-grid">
                ${publicationMarkup}
              </div>
            </section>
          </div>
          <aside class="version-detail-rail">
            <section class="card stack version-detail-section version-detail-review-card" data-version-detail-section="review">
              <div class="version-detail-section__header stack">
                <div class="version-detail-chip-row">
                  <p class="console-kicker">Review State</p>
                  ${renderVersionDetailPill(formatStatusLabel(detail.approvalState), approvalTone)}
                </div>
                <h2>Review State</h2>
                <p>${stateDescriptions[detail.approvalState]}</p>
              </div>
              ${
                detail.review.rejectedReason === null
                  ? ""
                  : `<p>Rejected reason: ${escapeHtml(detail.review.rejectedReason)}</p>`
              }
              ${
                actions.length === 0
                  ? `<p class="version-detail-note">No review action is available for this version state.</p>`
                  : `<div class="version-detail-action-cluster">${actions.join("")}</div>`
              }
              <div class="stack">
                <h3>Review History</h3>
                ${renderVersionDetailTimeline(detail.review, detail.active)}
              </div>
            </section>
            <section class="card stack version-detail-section version-detail-metadata-card" data-version-detail-section="metadata">
              <div class="version-detail-section__header stack">
                <p class="console-kicker">Version Metadata</p>
                <h2>Version Metadata</h2>
                <p>Version identity, ownership, and publication scope without introducing mock operational fields.</p>
              </div>
              ${renderVersionDetailDefinitionList([
                {
                  label: "Agent ID",
                  value: detail.agentId,
                },
                {
                  label: "Version ID",
                  value: detail.versionId,
                },
                {
                  label: "Publisher",
                  value: detail.publisherId,
                },
                {
                  label: "Capabilities",
                  value: formatDelimitedValue(detail.capabilities, "none declared"),
                },
                {
                  label: "Tags",
                  value: formatDelimitedValue(detail.tags, "none declared"),
                },
                {
                  label: "Required roles",
                  value: formatDelimitedValue(detail.requiredRoles, "none declared"),
                },
                {
                  label: "Required scopes",
                  value: formatDelimitedValue(detail.requiredScopes, "none declared"),
                },
              ])}
            </section>
          </aside>
        </section>
      </section>`,
      contextualNavigationItem: {
        href: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}`,
        label: "Version Detail",
      },
      currentNavigationKey: "contextual",
      pageId: "version-detail",
      principal,
      title: `Version ${detail.displayName}`,
    },
  );
}

function formatDelimitedValue(values: string[], emptyLabel: string): string {
  return values.length === 0 ? emptyLabel : values.join(", ");
}

function renderVersionDetailPill(
  label: string,
  tone: "accent" | "alert" | "muted" | "neutral" = "neutral",
): string {
  return `<span class="pill version-detail-pill version-detail-pill--${tone}">${escapeHtml(label)}</span>`;
}

function renderVersionDetailDefinitionList(items: Array<{ label: string; value: string }>): string {
  return `<dl class="version-detail-definition-list">
    ${items
      .map(
        (item) => `<div>
          <dt>${escapeHtml(item.label)}</dt>
          <dd>${escapeHtml(item.value)}</dd>
        </div>`,
      )
      .join("")}
  </dl>`;
}

function renderVersionDetailTimeline(
  review: {
    approvedAt: string | null;
    approvedBy: string | null;
    rejectedAt: string | null;
    rejectedBy: string | null;
    rejectedReason: string | null;
    submittedAt: string | null;
    submittedBy: string | null;
  },
  active: boolean,
): string {
  const events = [];

  if (review.approvedAt !== null) {
    events.push({
      at: String(review.approvedAt),
      label: "Approved",
      note: `Approved by ${review.approvedBy ?? "unknown reviewer"}.`,
    });
  }

  if (review.rejectedAt !== null) {
    events.push({
      at: String(review.rejectedAt),
      label: "Rejected",
      note:
        review.rejectedReason === null
          ? `Rejected by ${review.rejectedBy ?? "unknown reviewer"}.`
          : `Rejected by ${review.rejectedBy ?? "unknown reviewer"}: ${review.rejectedReason}`,
    });
  }

  if (review.submittedAt !== null) {
    events.push({
      at: String(review.submittedAt),
      label: "Submitted",
      note: `Submitted by ${review.submittedBy ?? "unknown publisher"}.`,
    });
  }

  if (active) {
    events.push({
      at: review.approvedAt === null ? String(review.submittedAt ?? "") : String(review.approvedAt),
      label: "Active Release",
      note: "This version is currently serving as the approved agent release.",
    });
  }

  if (events.length === 0) {
    return `<p class="version-detail-note">Draft has not entered review yet.</p>`;
  }

  return `<div class="version-detail-timeline">
    ${events
      .sort((left, right) => right.at.localeCompare(left.at))
      .map(
        (event) => `<article class="version-detail-timeline__item stack">
          <p class="console-kicker">${escapeHtml(event.at === "" ? "Not recorded" : event.at)}</p>
          <h3>${escapeHtml(event.label)}</h3>
          <p class="version-detail-note">${escapeHtml(event.note)}</p>
        </article>`,
      )
      .join("")}
  </div>`;
}

function renderAgentDetailPill(
  label: string,
  tone: "accent" | "alert" | "muted" | "neutral" = "neutral",
): string {
  return `<span class="pill agent-detail-pill agent-detail-pill--${tone}">${escapeHtml(label)}</span>`;
}

function renderAgentDetailDefinitionList(items: Array<{ label: string; value: string }>): string {
  return `<dl class="agent-detail-definition-list">
    ${items
      .map(
        (item) => `<div>
          <dt>${escapeHtml(item.label)}</dt>
          <dd>${escapeHtml(item.value)}</dd>
        </div>`,
      )
      .join("")}
  </dl>`;
}

function formatStatusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function renderOverlaySummary(
  label: string,
  overlay: {
    deprecated: boolean;
    disabled: boolean;
    requiredRoles: string[];
    requiredScopes: string[];
  },
  options: {
    actions?: string[];
    description?: string;
    eyebrow?: string;
  } = {},
): string {
  const stateChips = [
    renderAgentDetailPill(
      overlay.deprecated ? "Deprecated" : "Not deprecated",
      overlay.deprecated ? "alert" : "muted",
    ),
    renderAgentDetailPill(
      overlay.disabled ? "Disabled" : "Enabled",
      overlay.disabled ? "alert" : "accent",
    ),
  ];

  return `<article class="agent-detail-overlay-card stack">
    <div class="stack">
      <p class="console-kicker">${escapeHtml(options.eyebrow ?? "Overlay Summary")}</p>
      <h3>${escapeHtml(label)}</h3>
      ${
        options.description === undefined
          ? ""
          : `<p>${escapeHtml(options.description)}</p>`
      }
      <div class="agent-detail-chip-row">
        ${stateChips.join("")}
      </div>
      ${renderAgentDetailDefinitionList([
        {
          label: "Required roles",
          value: overlay.requiredRoles.join(", ") || "none",
        },
        {
          label: "Required scopes",
          value: overlay.requiredScopes.join(", ") || "none",
        },
      ])}
    </div>
    ${
      options.actions === undefined || options.actions.length === 0
        ? ""
        : `<div class="inline-actions agent-detail-actions">${options.actions.join("")}</div>`
    }
  </article>`;
}

async function renderAgentDetailPage(
  response: ServerResponse,
  adminRepository: KyselyAgentAdminDetailRepository,
  principal: ResolvedPrincipal,
  tenantId: string,
  agentId: string,
): Promise<void> {
  assertTenantAccess(principal, tenantId);
  assertTenantAdminAccess(principal);

  const detail = await adminRepository.getAgentDetail(tenantId, agentId);
  const environmentOverlaysByKey = new Map(
    detail.overlay.environments.map((overlay) => [overlay.environmentKey, overlay]),
  );
  const activePublicationMarkup =
    detail.activeVersion === null
      ? `<article class="agent-detail-publication-card stack">
          <p class="console-kicker">Active Publication Surfaces</p>
          <h3>No active approved version yet</h3>
          <p>Approve a submitted version to populate live publication surfaces and environment actions.</p>
        </article>`
      : detail.activeVersion.publications
          .map((publication) => {
            const latestTelemetry = publication.telemetry[0];
            const environmentOverlay = environmentOverlaysByKey.get(publication.environmentKey);
            const overlayChips =
              environmentOverlay === undefined
                ? `<div class="agent-detail-chip-row">
                     ${renderAgentDetailPill("No environment overlay", "muted")}
                   </div>`
                : `<div class="agent-detail-chip-row">
                     ${renderAgentDetailPill(
                       environmentOverlay.deprecated ? "Deprecated" : "Not deprecated",
                       environmentOverlay.deprecated ? "alert" : "muted",
                     )}
                     ${renderAgentDetailPill(
                       environmentOverlay.disabled ? "Disabled" : "Enabled",
                       environmentOverlay.disabled ? "alert" : "accent",
                     )}
                   </div>`;

            return `<article class="agent-detail-publication-card stack">
              <div class="agent-detail-publication-card__header">
                <div class="stack">
                  <p class="console-kicker">Environment Surface</p>
                  <h3>${escapeHtml(publication.environmentKey)}</h3>
                </div>
                ${renderAgentDetailPill(
                  `Health ${publication.healthStatus ?? "unknown"}`,
                  publication.healthStatus === "healthy" ? "accent" : "neutral",
                )}
              </div>
              <p class="agent-detail-note">
                Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code>
              </p>
              ${overlayChips}
              ${
                latestTelemetry === undefined
                  ? `<p class="agent-detail-note">No advisory telemetry has been recorded for this publication yet.</p>`
                  : renderAgentDetailDefinitionList([
                      {
                        label: "Invocation count",
                        value: String(latestTelemetry.invocationCount),
                      },
                      {
                        label: "Error count",
                        value: String(latestTelemetry.errorCount),
                      },
                      {
                        label: "p95 latency",
                        value:
                          latestTelemetry.p95LatencyMs === null
                            ? "n/a"
                            : `${latestTelemetry.p95LatencyMs} ms`,
                      },
                    ])
              }
              <div class="inline-actions agent-detail-actions">
                <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/deprecate" method="post">
                  <button type="submit">Deprecate Environment</button>
                </form>
                <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/disable" method="post">
                  <button class="button-secondary" type="submit">Disable Environment</button>
                </form>
              </div>
            </article>`;
          })
          .join("");
  const environmentOverlayMarkup =
    detail.overlay.environments.length === 0
      ? `<article class="agent-detail-overlay-card stack">
          <div class="stack">
            <p class="console-kicker">Environment Overlay Summary</p>
            <h3>No environment overrides applied</h3>
            <p>Per-environment overlay state will appear here as policy overrides are stored.</p>
          </div>
        </article>`
      : detail.overlay.environments
          .map((overlay) =>
            renderOverlaySummary(`Environment overlay for ${overlay.environmentKey}`, overlay, {
              description: "Current stored policy override for this publication surface.",
              eyebrow: "Environment Overlay Summary",
            }),
          )
          .join("");
  const activeVersionSummary = detail.activeVersion;
  const versionHistoryMarkup =
    detail.versions.length === 0
      ? `<p>No version history is available for this agent yet.</p>`
      : detail.versions
          .map(
            (version) => `<a class="agent-detail-history__item" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version.versionId)}">
              <div class="stack">
                <p class="console-kicker">Version ${version.versionSequence}</p>
                <h3>${detail.activeVersionId === version.versionId ? "Current release" : "Historical record"}</h3>
                <p class="agent-detail-note"><code>${escapeHtml(version.versionId)}</code></p>
              </div>
              <div class="agent-detail-chip-row">
                ${renderAgentDetailPill(formatStatusLabel(version.approvalState), "neutral")}
                ${
                  detail.activeVersionId === version.versionId
                    ? renderAgentDetailPill("Active", "accent")
                    : ""
                }
              </div>
            </a>`,
          )
          .join("");
  const heroLinks = [
    `<a class="pill agent-detail-pill agent-detail-pill--muted" href="/console">Back to dashboard</a>`,
  ];

  if (activeVersionSummary !== null) {
    heroLinks.push(
      `<a class="pill agent-detail-pill agent-detail-pill--accent" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(activeVersionSummary.versionId)}">Open active version detail</a>`,
    );
  }

  writeHtml(
    response,
    200,
    {
      body: `<section class="agent-detail-page stack">
        <section class="agent-detail-hero card">
          <div class="agent-detail-hero__copy stack">
            <div class="stack">
              <p class="console-kicker">Active Agent Detail</p>
              <div class="agent-detail-chip-row">
                <span class="agent-detail-pulse" aria-hidden="true"></span>
                ${
                  activeVersionSummary === null
                    ? renderAgentDetailPill("Awaiting approved release", "muted")
                    : renderAgentDetailPill("Active approved release", "accent")
                }
                ${
                  activeVersionSummary === null
                    ? ""
                    : renderAgentDetailPill(`Version ${activeVersionSummary.versionSequence}`, "neutral")
                }
              </div>
            </div>
            <h1>${escapeHtml(detail.agentId)}</h1>
            <p class="agent-detail-hero__lede">
              Tenant-admin control surface for live publications, stored overlays, and version navigation.
            </p>
          </div>
          <div class="agent-detail-hero__aside stack">
            <div class="agent-detail-summary-grid">
              <article class="agent-detail-summary-card">
                <p class="console-kicker">Active Version</p>
                <h2>${escapeHtml(detail.activeVersionId ?? "none")}</h2>
              </article>
              <article class="agent-detail-summary-card">
                <p class="console-kicker">Approval State</p>
                <h2>${escapeHtml(activeVersionSummary?.approvalState ?? "inactive")}</h2>
              </article>
              <article class="agent-detail-summary-card">
                <p class="console-kicker">Published Environments</p>
                <h2>${String(activeVersionSummary?.publications.length ?? 0)}</h2>
              </article>
              <article class="agent-detail-summary-card">
                <p class="console-kicker">Approved By</p>
                <h2>${escapeHtml(activeVersionSummary?.review.approvedBy ?? "not recorded")}</h2>
              </article>
            </div>
            <div class="agent-detail-link-row">
              ${heroLinks.join("")}
            </div>
          </div>
        </section>
        <section class="agent-detail-layout">
          <section class="card stack agent-detail-section">
            <div class="agent-detail-section__header stack">
              <p class="console-kicker">Overlay Summary</p>
              <h2>Overlay Control Center</h2>
              <p>Apply stored agent-level controls here, then review each environment surface for publication-specific overrides.</p>
            </div>
            <div class="agent-detail-overlay-grid">
              ${renderOverlaySummary("Agent overlay", detail.overlay.agent, {
                actions: [
                  `<form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/overlay/deprecate" method="post">
                     <button type="submit">Deprecate Agent</button>
                   </form>`,
                  `<form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/overlay/disable" method="post">
                     <button class="button-secondary" type="submit">Disable Agent</button>
                   </form>`,
                ],
                description: "Current stored policy override for the active agent.",
                eyebrow: "Agent Overlay Summary",
              })}
              ${environmentOverlayMarkup}
            </div>
          </section>
          <aside class="card stack agent-detail-section">
            <div class="agent-detail-section__header stack">
              <p class="console-kicker">Audit Trail</p>
              <h2>Version History</h2>
              <p>Every saved version remains one click away from the current detail route.</p>
            </div>
            <div class="agent-detail-history">
              ${versionHistoryMarkup}
            </div>
          </aside>
        </section>
        <section class="stack agent-detail-section">
          <div class="agent-detail-section__header stack">
            <p class="console-kicker">Publication Surface</p>
            <h2>Active Publication Surfaces</h2>
            <p>Truthful environment state only: health endpoint, latest advisory telemetry, and environment overlay actions.</p>
          </div>
          <div class="agent-detail-publication-grid">
            ${activePublicationMarkup}
          </div>
        </section>
      </section>`,
      contextualNavigationItem: {
        href: `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}`,
        label: "Agent Detail",
      },
      currentNavigationKey: "contextual",
      pageId: "agent-detail",
      principal,
      title: "Active Agent Detail",
    },
  );
}

async function handleVersionAction(
  response: ServerResponse,
  request: IncomingMessage,
  reviewService: AgentVersionReviewService,
  principal: ResolvedPrincipal,
  tenantId: string,
  agentId: string,
  versionId: string,
  action: "approve" | "reject" | "submit",
): Promise<void> {
  assertTenantAccess(principal, tenantId);

  if (action === "submit") {
    await reviewService.submitVersion(principal, tenantId, agentId, versionId);
    redirect(
      response,
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}`,
    );
    return;
  }

  if (action === "approve") {
    await reviewService.approveVersion(principal, tenantId, agentId, versionId);
    redirect(
      response,
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}`,
    );
    return;
  }

  const formData = await readFormData(request);
  await reviewService.rejectVersion(
    principal,
    tenantId,
    agentId,
    versionId,
    readStringField(formData, "reason", {
      required: true,
    }),
  );
  redirect(
    response,
    `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}`,
  );
}

async function handleOverlayAction(
  response: ServerResponse,
  overlayService: TenantPolicyOverlayService,
  principal: ResolvedPrincipal,
  input: {
    action: "deprecate" | "disable";
    agentId: string;
    environmentKey: string | null;
    tenantId: string;
  },
): Promise<void> {
  assertTenantAccess(principal, input.tenantId);
  assertTenantAdminAccess(principal);

  if (input.environmentKey === null) {
    if (input.action === "deprecate") {
      await overlayService.deprecateAgent(principal, input.tenantId, input.agentId);
    } else {
      await overlayService.disableAgent(principal, input.tenantId, input.agentId);
    }
  } else if (input.action === "deprecate") {
    await overlayService.deprecateEnvironment(
      principal,
      input.tenantId,
      input.agentId,
      input.environmentKey,
    );
  } else {
    await overlayService.disableEnvironment(
      principal,
      input.tenantId,
      input.agentId,
      input.environmentKey,
    );
  }

  redirect(
    response,
    `/tenants/${encodeURIComponent(input.tenantId)}/agents/${encodeURIComponent(input.agentId)}`,
  );
}

export function createWebRequestListener(options: WebRequestListenerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const config = options.config ?? loadRegistryConfig(process.env, { requireBootstrapFile: false });
  const principalResolver = new PrincipalResolver(new KyselyTenantMembershipLookup(options.db));
  const environmentService = new TenantEnvironmentCatalogService(
    new KyselyTenantEnvironmentRepository(options.db),
  );
  const draftService = new AgentDraftRegistrationService(
    new KyselyAgentDraftRegistrationRepository(options.db),
    new KyselyTenantEnvironmentRepository(options.db),
    new KyselyTenantRepository(options.db),
    {
      deploymentMode: config.deploymentMode,
      rawCardByteLimit: config.rawCardByteLimit,
      requireHttpsHealthEndpoints: config.healthProbe.requireHttps,
    },
  );
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(options.db),
    {
      allowPrivateTargets: config.healthProbe.allowPrivateTargets,
      deploymentMode: config.deploymentMode,
      requireHttps: config.healthProbe.requireHttps,
      ...options.reviewServiceOptions,
    },
  );
  const overlayService = new TenantPolicyOverlayService(
    new KyselyTenantPolicyOverlayRepository(options.db),
  );
  const adminRepository = new KyselyAgentAdminDetailRepository(options.db);
  const healthRepository = new KyselyHealthRepository(options.db);

  return async (request, response) => {
    try {
      const pathname = getPathname(request);

      if (await handleAssetRequest(request, response, pathname)) {
        return;
      }

      if (request.method === "GET" && pathname === "/") {
        const principal = await resolvePrincipalFromSession(principalResolver, request).catch(() => null);

        if (principal !== null) {
          redirect(response, "/console");
          return;
        }

        await renderSignInPage(
          response,
          options.db,
          config.deploymentMode,
          getRequestUrl(request).searchParams.get("tenantId") ?? undefined,
        );
        return;
      }

      if (request.method === "POST" && pathname === "/session") {
        const formData = await readFormData(request);
        const tenantId = readStringField(formData, "tenantId", {
          required: true,
        });
        const subjectId = readStringField(formData, "subjectId", {
          required: true,
        });

        try {
          await principalResolver.resolve({
            auth: {
              subjectId,
            },
            tenantId,
          });
        } catch {
          throw new ConsoleAuthorizationError(
            "The selected subject does not belong to the chosen tenant.",
          );
        }
        redirect(
          response,
          "/console",
          [createSessionCookie({ subjectId, tenantId })],
        );
        return;
      }

      if (request.method === "POST" && pathname === "/session/logout") {
        redirect(response, "/", [createExpiredSessionCookie()]);
        return;
      }

      const principal = await requirePrincipal(response, principalResolver, request);

      if (principal === null) {
        return;
      }

      if (request.method === "GET" && pathname === "/console") {
        await renderDashboard(response, options.db, principal);
        return;
      }

      const environmentMatch = /^\/tenants\/([^/]+)\/environments\/?$/.exec(pathname);

      if (environmentMatch !== null) {
        const tenantId = decodeURIComponent(environmentMatch[1]);

        if (request.method === "GET") {
          await renderEnvironmentPage(response, environmentService, principal, tenantId);
          return;
        }

        if (request.method === "POST") {
          await createEnvironmentFromForm(response, request, environmentService, principal, tenantId);
          return;
        }
      }

      const draftNewMatch = /^\/tenants\/([^/]+)\/drafts\/new\/?$/.exec(pathname);

      if (draftNewMatch !== null && request.method === "GET") {
        await renderDraftFormPage(
          response,
          options.db,
          environmentService,
          principal,
          decodeURIComponent(draftNewMatch[1]),
        );
        return;
      }

      const draftCreateMatch = /^\/tenants\/([^/]+)\/drafts\/?$/.exec(pathname);

      if (draftCreateMatch !== null && request.method === "POST") {
        await createDraftFromForm(
          response,
          request,
          environmentService,
          draftService,
          principal,
          decodeURIComponent(draftCreateMatch[1]),
        );
        return;
      }

      const reviewMatch = /^\/tenants\/([^/]+)\/review\/?$/.exec(pathname);

      if (reviewMatch !== null && request.method === "GET") {
        await renderReviewQueuePage(
          response,
          options.db,
          principal,
          decodeURIComponent(reviewMatch[1]),
        );
        return;
      }

      const versionActionMatch =
        /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/([^/]+)\/(submit|approve|reject)\/?$/.exec(
          pathname,
        );

      if (versionActionMatch !== null && request.method === "POST") {
        await handleVersionAction(
          response,
          request,
          reviewService,
          principal,
          decodeURIComponent(versionActionMatch[1]),
          decodeURIComponent(versionActionMatch[2]),
          decodeURIComponent(versionActionMatch[3]),
          versionActionMatch[4] as "approve" | "reject" | "submit",
        );
        return;
      }

      const environmentOverlayMatch =
        /^\/tenants\/([^/]+)\/agents\/([^/]+)\/environments\/([^/]+)\/overlay\/(disable|deprecate)\/?$/.exec(
          pathname,
        );

      if (environmentOverlayMatch !== null && request.method === "POST") {
        await handleOverlayAction(response, overlayService, principal, {
          action: environmentOverlayMatch[4] as "deprecate" | "disable",
          agentId: decodeURIComponent(environmentOverlayMatch[2]),
          environmentKey: decodeURIComponent(environmentOverlayMatch[3]),
          tenantId: decodeURIComponent(environmentOverlayMatch[1]),
        });
        return;
      }

      const agentOverlayMatch =
        /^\/tenants\/([^/]+)\/agents\/([^/]+)\/overlay\/(disable|deprecate)\/?$/.exec(pathname);

      if (agentOverlayMatch !== null && request.method === "POST") {
        await handleOverlayAction(response, overlayService, principal, {
          action: agentOverlayMatch[3] as "deprecate" | "disable",
          agentId: decodeURIComponent(agentOverlayMatch[2]),
          environmentKey: null,
          tenantId: decodeURIComponent(agentOverlayMatch[1]),
        });
        return;
      }

      const versionDetailMatch =
        /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/([^/]+)\/?$/.exec(pathname);

      if (versionDetailMatch !== null && request.method === "GET") {
        await renderVersionDetailPage(
          response,
          adminRepository,
          healthRepository,
          principal,
          decodeURIComponent(versionDetailMatch[1]),
          decodeURIComponent(versionDetailMatch[2]),
          decodeURIComponent(versionDetailMatch[3]),
        );
        return;
      }

      const agentDetailMatch = /^\/tenants\/([^/]+)\/agents\/([^/]+)\/?$/.exec(pathname);

      if (agentDetailMatch !== null && request.method === "GET") {
        await renderAgentDetailPage(
          response,
          adminRepository,
          principal,
          decodeURIComponent(agentDetailMatch[1]),
          decodeURIComponent(agentDetailMatch[2]),
        );
        return;
      }

      writeError(response, 404, "Route not found.");
    } catch (error) {
      if (error instanceof URIError) {
        writeError(response, 400, "Invalid request path.");
        return;
      }

      if (error instanceof ConsoleAuthorizationError) {
        writeError(response, 403, error.message);
        return;
      }

      if (error instanceof ConsoleValidationError) {
        writeError(response, 400, error.message);
        return;
      }

      if (
        error instanceof EnvironmentCatalogAuthorizationError ||
        error instanceof AgentDraftRegistrationAuthorizationError ||
        error instanceof AgentVersionReviewAuthorizationError ||
        error instanceof TenantPolicyOverlayAuthorizationError
      ) {
        writeError(response, 403, error.message);
        return;
      }

      if (
        error instanceof EnvironmentCatalogDuplicateError ||
        error instanceof EnvironmentCatalogValidationError ||
        error instanceof AgentDraftRegistrationValidationError ||
        error instanceof AgentVersionReviewValidationError ||
        error instanceof AgentVersionProbeTargetPolicyError
      ) {
        writeError(response, 400, error.message);
        return;
      }

      if (
        error instanceof AgentDraftNotFoundError ||
        error instanceof AgentNotFoundError ||
        error instanceof AgentVersionNotFoundError
      ) {
        writeError(response, 404, error.message);
        return;
      }

      if (error instanceof InvalidVersionTransitionError) {
        writeError(response, 409, error.message);
        return;
      }

      if (error instanceof Error) {
        writeError(response, 500, "Internal server error.");
        return;
      }

      writeError(response, 500, "Internal server error.");
    }
  };
}
