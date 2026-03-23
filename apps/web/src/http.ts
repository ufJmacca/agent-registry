import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { hasAnyRole, PrincipalResolver, type ResolvedPrincipal } from "@agent-registry/auth";
import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  AgentNotFoundError,
  AgentVersionNotFoundError,
  KyselyAgentAdminDetailRepository,
  KyselyAgentDiscoveryRepository,
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
import { resolveStaticAsset, writeStaticAsset } from "./ui/assets.js";
import { escapeHtml, renderDocument, renderPreformattedJson } from "./ui/document.js";
import {
  renderDashboardPage,
  type DashboardActiveAgentLink,
  type DashboardVersionLink,
} from "./ui/pages/dashboard.js";
import { renderAuthenticatedShell, renderPublicShell, type ShellNavItem } from "./ui/shell.js";

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

interface ReviewQueueEntry {
  agentId: string;
  displayName: string;
  submittedAt: string | null;
  versionId: string;
  versionSequence: number;
}

function writeHtml(
  response: ServerResponse,
  statusCode: number,
  title: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(
    renderDocument({
      body,
      title,
    }),
  );
}

function writeError(response: ServerResponse, statusCode: number, message: string): void {
  writeHtml(
    response,
    statusCode,
    "Console Error",
    `<div class="document-page">
      <section class="hero card stack">
        <h1>Console Error</h1>
        <p>${escapeHtml(message)}</p>
        <p><a href="/">Return to sign-in</a></p>
      </section>
    </div>`,
  );
}

function buildShellNavItems(
  principal: ResolvedPrincipal,
  currentPage: string,
): ShellNavItem[] {
  const items: ShellNavItem[] = [
    {
      current: currentPage === "console-dashboard",
      href: "/console",
      label: "Overview",
    },
  ];

  if (canPublish(principal)) {
    items.push({
      current: currentPage === "new-draft-registration",
      href: `/tenants/${encodeURIComponent(principal.tenantId)}/drafts/new`,
      label: "New Draft Registration",
    });
  }

  if (isTenantAdmin(principal)) {
    items.push(
      {
        current: currentPage === "tenant-environments",
        href: `/tenants/${encodeURIComponent(principal.tenantId)}/environments`,
        label: "Environment Management",
      },
      {
        current: currentPage === "review-queue",
        href: `/tenants/${encodeURIComponent(principal.tenantId)}/review`,
        label: "Review Queue",
      },
    );
  }

  return items;
}

function writePublicPage(
  response: ServerResponse,
  title: string,
  page: string,
  body: string,
): void {
  writeHtml(
    response,
    200,
    title,
    renderPublicShell({
      body,
      page,
    }),
  );
}

function writeAuthenticatedPage(
  response: ServerResponse,
  options: {
    body: string;
    page: string;
    principal: ResolvedPrincipal;
    tenantLabel?: string;
    title: string;
  },
): void {
  writeHtml(
    response,
    200,
    options.title,
    renderAuthenticatedShell({
      body: options.body,
      navItems: buildShellNavItems(options.principal, options.page),
      page: options.page,
      principal: options.principal,
      tenantLabel: options.tenantLabel,
    }),
  );
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

function renderSignInLanding(options: {
  accessPanel: string;
  emphasizeSetup: boolean;
  setupPanel: string;
}): string {
  return `<section class="public-hero card stack">
    <span class="shell-eyebrow">Agent Registry Console</span>
    <h1>Architectural Precision For Tenant Operations</h1>
    <p class="meta">Manage truthful draft, review, environment, and active agent workflows inside a shared technical curator shell.</p>
  </section>
  <section class="public-grid">
    <div class="stack">
      ${options.emphasizeSetup ? options.setupPanel : options.accessPanel}
    </div>
    <div class="stack">
      ${options.emphasizeSetup ? options.accessPanel : options.setupPanel}
    </div>
  </section>`;
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
      writePublicPage(
        response,
        "Agent Registry",
        "sign-in",
        renderSignInLanding({
          accessPanel: `<section class="card stack" data-visual-dynamic="sign-in-access">
            <span class="shell-eyebrow">Registry Access</span>
            <h2>Console Setup Pending</h2>
            <p>Registry access will become available after migrations and bootstrap data are loaded.</p>
            <p class="meta">The sign-in flow is intentionally withheld until the console can resolve truthful tenant memberships.</p>
          </section>`,
          emphasizeSetup: true,
          setupPanel: `<section class="card stack public-companion">
            <span class="shell-eyebrow">Setup Status</span>
            <h2>Initialize The Console</h2>
            <p>Run migrations and load bootstrap tenant data to enable console sign-in.</p>
            <div class="section-list">
              <div class="pill">Schema missing</div>
              <div class="pill">Bootstrap required</div>
            </div>
          </section>`,
        }),
      );
      return;
    }

    throw error;
  }

  if (tenants.length === 0) {
    writePublicPage(
      response,
      "Agent Registry",
      "sign-in",
      renderSignInLanding({
        accessPanel: `<section class="card stack" data-visual-dynamic="sign-in-access">
          <span class="shell-eyebrow">Registry Access</span>
          <h2>Console Setup Pending</h2>
          <p>Sign-in will appear after at least one tenant and membership set has been bootstrapped.</p>
          <p class="meta">No internal bootstrap details are exposed here.</p>
        </section>`,
        emphasizeSetup: true,
        setupPanel: `<section class="card stack public-companion">
          <span class="shell-eyebrow">Setup Status</span>
          <h2>Bootstrap Tenant Data</h2>
          <p>Bootstrap tenant and membership data to enable console sign-in.</p>
          <div class="section-list">
            <div class="pill">No tenants</div>
            <div class="pill">No memberships</div>
          </div>
        </section>`,
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
  const subjectOptions = visibleTenant.memberships
    .map(
      (membership) =>
        `<option value="${escapeHtml(membership.subjectId)}">${escapeHtml(membership.subjectId)} [${escapeHtml(membership.roles.join(", ") || "no roles")}]</option>`,
    )
    .join("");

  writePublicPage(
    response,
    "Agent Registry",
    "sign-in",
    renderSignInLanding({
      accessPanel: `<section class="card stack" data-visual-dynamic="sign-in-access">
        <span class="shell-eyebrow">Registry Access</span>
        <h2>Mock Sign-In</h2>
        <p class="meta">Use truthful tenant memberships to enter the current console without changing any existing sign-in behavior.</p>
        <form class="stack" action="/session" method="post">
          ${
            deploymentMode === "self-hosted"
              ? `<p>Single-tenant deployment</p>
                 <input type="hidden" name="tenantId" value="${escapeHtml(selfHostedTenant.tenantId)}" />
                 <p><strong>${escapeHtml(selfHostedTenant.displayName)}</strong> (${escapeHtml(selfHostedTenant.tenantId)})</p>`
              : `<label>Tenant
                   <select name="tenantId" onchange="window.location='/?tenantId='+encodeURIComponent(this.value)">
                     ${hostedTenantOptions}
                   </select>
                 </label>`
          }
          <label>Subject
            <select name="subjectId">
              ${
                subjectOptions === ""
                  ? `<option value="" disabled selected>No memberships available for ${escapeHtml(visibleTenant.displayName)}</option>`
                  : subjectOptions
              }
            </select>
          </label>
          <button type="submit">Sign In</button>
        </form>
      </section>`,
      emphasizeSetup: false,
      setupPanel: `<section class="card stack public-companion">
        <span class="shell-eyebrow">Workspace State</span>
        <h2>${escapeHtml(visibleTenant.displayName)}</h2>
        <p>Current deployment mode: <strong>${escapeHtml(deploymentMode)}</strong>.</p>
        <p class="meta">Tenant selection and membership collapse continue to follow the existing hosted and self-hosted rules.</p>
        <div class="public-signal-grid">
          <div class="public-signal">
            <span class="shell-eyebrow">Tenant</span>
            <strong>${escapeHtml(visibleTenant.tenantId)}</strong>
          </div>
          <div class="public-signal">
            <span class="shell-eyebrow">Memberships</span>
            <strong>${String(visibleTenant.memberships.length)}</strong>
          </div>
        </div>
      </section>`,
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
): Promise<DashboardActiveAgentLink[]> {
  const publications = await new KyselyAgentDiscoveryRepository(db).listActiveApprovedPublications(
    tenantId,
  );
  const activeAgents = new Map<string, DashboardActiveAgentLink>();

  for (const publication of publications) {
    if (
      publication.agentDisabled ||
      publication.overlayAgentDisabled ||
      publication.overlayEnvironmentDisabled
    ) {
      continue;
    }

    if (!activeAgents.has(publication.agentId)) {
      activeAgents.set(publication.agentId, {
        agentId: publication.agentId,
        displayName: publication.displayName,
      });
    }
  }

  return Array.from(activeAgents.values()).sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) ||
      left.agentId.localeCompare(right.agentId),
  );
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

  writeAuthenticatedPage(response, {
    body: renderDashboardPage({
      activeAgents,
      canPublish: canPublish(principal),
      isTenantAdmin: isTenantAdmin(principal),
      principal,
      tenantDisplayName,
      versions,
    }),
    page: "console-dashboard",
    principal,
    tenantLabel: tenantDisplayName,
    title: "Console Dashboard",
  });
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
  return `<form class="stack" action="/tenants/${encodeURIComponent(tenantId)}/environments" method="post">
    <label>Environment key
      <input name="environmentKey" placeholder="qa" />
    </label>
    <button type="submit">Add Environment</button>
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

  writeAuthenticatedPage(response, {
    body: `<section class="hero card stack page-hero">
      <span class="shell-eyebrow">Tenant Operations</span>
      <h1>Environment Management</h1>
      <p class="meta">Tenant ${escapeHtml(tenantId)}</p>
      <p>Configured environments remain the primary record, with environment creation kept secondary and truthful to the existing POST flow.</p>
    </section>
    <section class="split">
      <div class="card stack">
        <h2>Configured Environments</h2>
        <div class="section-list" data-visual-dynamic="environment-list">
          ${environments.environments.map((environment) => `<div class="pill">${escapeHtml(environment.environmentKey)}</div>`).join("")}
        </div>
      </div>
      <div class="card stack">
        <h2>Add Environment</h2>
        ${renderEnvironmentForm(tenantId)}
      </div>
    </section>`,
    page: "tenant-environments",
    principal,
    title: "Environment Management",
  });
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
        `<section class="card stack">
          <h3>${escapeHtml(environment.environmentKey)}</h3>
          <label>
            <input type="checkbox" name="publication:${escapeHtml(environment.environmentKey)}:enabled" />
            Include this environment publication
          </label>
          <label>Health endpoint URL
            <input name="publication:${escapeHtml(environment.environmentKey)}:healthEndpointUrl" placeholder="https://${escapeHtml(environment.environmentKey)}.health.example.com/status" />
          </label>
          <label>Optional invocation endpoint override
            <input name="publication:${escapeHtml(environment.environmentKey)}:invocationEndpoint" placeholder="https://agent.example.com/invoke" />
          </label>
          <label>Raw card upload
            <input type="file" name="publication:${escapeHtml(environment.environmentKey)}:rawCard" />
          </label>
        </section>`,
    )
    .join("");

  writeAuthenticatedPage(response, {
    body: `<section class="hero card stack page-hero">
      <span class="shell-eyebrow">Draft Registration</span>
      <h1>New Draft Registration</h1>
      <p class="meta">Create one immutable version snapshot with shared metadata and multiple environment-specific cards.</p>
      <p>Every existing field and multipart upload remains intact while the form now sits inside the shared authenticated shell.</p>
    </section>
    <form class="stack" action="/tenants/${encodeURIComponent(tenantId)}/drafts" method="post" enctype="multipart/form-data">
      <section class="split">
        <div class="card stack">
          <label>Version label
            <input name="versionLabel" placeholder="v1" />
          </label>
          <label>Display name
            <input name="displayName" placeholder="Case Resolver" />
          </label>
          <label>Summary
            <textarea name="summary" rows="5" placeholder="Handles support case routing."></textarea>
          </label>
          <label>Capabilities
            <textarea name="capabilities" rows="4" placeholder="shared-capability, case-routing"></textarea>
          </label>
          <label>Tags
            <textarea name="tags" rows="3" placeholder="shared-tag, routing"></textarea>
          </label>
          <label>Required roles
            <textarea name="requiredRoles" rows="3" placeholder="support-agent"></textarea>
          </label>
          <label>Required scopes
            <textarea name="requiredScopes" rows="3" placeholder="tickets.read, tickets.write"></textarea>
          </label>
        </div>
        <div class="card stack">
          <label>Header contract JSON
            <textarea name="headerContract" rows="10">[
  {
    "name": "X-User-Id",
    "required": true,
    "source": "user.id",
    "description": "Identifies the calling user."
  }
]</textarea>
          </label>
          <label>Context contract JSON
            <textarea name="contextContract" rows="10">[
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
      <section class="stack" data-visual-dynamic="publication-sections">
        <h2>Environment Publications</h2>
        ${publicationFields}
      </section>
      <button type="submit">Create Draft</button>
    </form>`,
    page: "new-draft-registration",
    principal,
    title: "New Draft Registration",
  });
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

  const queue = await listReviewQueue(db, tenantId);

  writeAuthenticatedPage(response, {
    body: `<section class="hero card stack page-hero">
      <span class="shell-eyebrow">Decision Queue</span>
      <h1>Review Queue</h1>
      <p class="meta">Pending versions for ${escapeHtml(tenantId)}</p>
      <p>Approval and rejection remain immediately available while the queue inherits the shared shell and stable masking hooks.</p>
    </section>
    <section class="stack" data-visual-dynamic="review-queue">
      ${
        queue.length === 0
          ? `<div class="card"><p>No versions are awaiting review.</p></div>`
          : queue
              .map(
                (entry) =>
                  `<div class="card stack">
                    <h2>${escapeHtml(entry.displayName)}</h2>
                    <p>Version ${entry.versionSequence}${entry.submittedAt === null ? "" : ` submitted at ${escapeHtml(entry.submittedAt)}`}</p>
                    <p><a href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}">Inspect version detail</a></p>
                    <div class="inline-actions">
                      <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}/approve" method="post">
                        <button type="submit">Approve</button>
                      </form>
                      <form class="stack" action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(entry.agentId)}/versions/${encodeURIComponent(entry.versionId)}/reject" method="post">
                        <label>Reject reason
                          <input name="reason" placeholder="Needs clearer scopes." />
                        </label>
                        <button class="button-secondary" type="submit">Reject</button>
                      </form>
                    </div>
                  </div>`,
              )
              .join("")
      }
    </section>`,
    page: "review-queue",
    principal,
    title: "Review Queue",
  });
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
  const publicationMarkup = detail.publications
    .map((publication) => {
      const health = healthByEnvironment.get(publication.environmentKey);

      return `<section class="card stack">
        <h2>Environment: ${escapeHtml(publication.environmentKey)}</h2>
        <p>Health status: ${escapeHtml(publication.healthStatus ?? "unknown")}</p>
        <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
        <p>Invocation endpoint: <code>${escapeHtml(publication.invocationEndpoint ?? "none")}</code></p>
        <h3>Normalized Metadata</h3>
        ${renderPreformattedJson(publication.normalizedMetadata)}
        <h3>Raw Card</h3>
        <pre>${escapeHtml(publication.rawCard)}</pre>
        ${
          isTenantAdmin(principal)
            ? `<h3>Advisory Telemetry</h3>
               ${
                 publication.telemetry.length === 0
                   ? "<p>No advisory telemetry submitted.</p>"
                   : publication.telemetry
                       .map(
                         (telemetry) =>
                           `<div class="stack">
                             <p>Invocation count: ${telemetry.invocationCount}</p>
                             <p>Success count: ${telemetry.successCount}</p>
                             <p>Error count: ${telemetry.errorCount}</p>
                             <p>p95 latency: ${telemetry.p95LatencyMs ?? "n/a"}</p>
                           </div>`,
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
                           `<p>${escapeHtml(entry.checkedAt)} status ${entry.statusCode === null ? "n/a" : String(entry.statusCode)}${entry.error === null ? "" : ` error ${escapeHtml(entry.error)}`}</p>`,
                       )
                       .join("")
               }`
        }
      </section>`;
    })
    .join("");
  const actions = [];

  if (detail.approvalState === "draft" && canPublish(principal)) {
    actions.push(
      `<form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/submit" method="post">
         <button type="submit">Submit for Review</button>
       </form>`,
    );
  }

  if (detail.approvalState === "pending_review" && isTenantAdmin(principal)) {
    actions.push(
      `<form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/approve" method="post">
         <button type="submit">Approve</button>
       </form>`,
    );
    actions.push(
      `<form class="stack" action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/reject" method="post">
         <label>Reject reason
           <input name="reason" placeholder="Needs clearer scopes." />
         </label>
         <button class="button-secondary" type="submit">Reject</button>
       </form>`,
    );
  }

  writeAuthenticatedPage(response, {
    body: `<section class="hero card stack page-hero">
      <span class="shell-eyebrow">Version Detail</span>
      <h1>${escapeHtml(detail.displayName)}</h1>
      <p>Approval state: ${escapeHtml(detail.approvalState)}</p>
      <p>Version label: ${escapeHtml(detail.versionLabel)} | Version sequence: ${detail.versionSequence}</p>
      ${
        detail.active
          ? `<p><a href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}">Open active agent detail</a></p>`
          : ""
      }
      ${
        detail.review.rejectedReason === null
          ? ""
          : `<p>Rejected reason: ${escapeHtml(detail.review.rejectedReason)}</p>`
      }
    </section>
    <section class="split">
      <div class="card stack">
        <h2>Header Contract</h2>
        ${renderPreformattedJson(detail.headerContract)}
      </div>
      <div class="card stack">
        <h2>Context Contract</h2>
        ${renderPreformattedJson(detail.contextContract)}
      </div>
    </section>
    ${
      actions.length === 0
        ? ""
        : `<section class="card stack">
             <h2>Version Actions</h2>
             <div class="inline-actions">${actions.join("")}</div>
           </section>`
    }
    <section class="stack" data-visual-dynamic="publication-detail-list">
      ${publicationMarkup}
    </section>`,
    page: "version-detail",
    principal,
    title: `Version ${detail.displayName}`,
  });
}

function renderOverlaySummary(
  label: string,
  overlay: {
    deprecated: boolean;
    disabled: boolean;
    requiredRoles: string[];
    requiredScopes: string[];
  },
): string {
  return `<section class="card stack">
    <h3>${escapeHtml(label)}</h3>
    <p>Deprecated: ${overlay.deprecated ? "yes" : "no"}</p>
    <p>Disabled: ${overlay.disabled ? "yes" : "no"}</p>
    <p>Required roles: ${escapeHtml(overlay.requiredRoles.join(", ") || "none")}</p>
    <p>Required scopes: ${escapeHtml(overlay.requiredScopes.join(", ") || "none")}</p>
  </section>`;
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
  const activePublicationMarkup =
    detail.activeVersion === null
      ? "<p>No active approved version yet.</p>"
      : detail.activeVersion.publications
          .map(
            (publication) =>
              `<section class="card stack">
                <h3>${escapeHtml(publication.environmentKey)}</h3>
                <p>Health status: ${escapeHtml(publication.healthStatus ?? "unknown")}</p>
                <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
                <div class="inline-actions">
                  <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/deprecate" method="post">
                    <button type="submit">Deprecate Environment</button>
                  </form>
                  <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/disable" method="post">
                    <button class="button-secondary" type="submit">Disable Environment</button>
                  </form>
                </div>
              </section>`,
          )
          .join("");

  writeAuthenticatedPage(response, {
    body: `<section class="hero card stack page-hero">
      <span class="shell-eyebrow">Active Agent</span>
      <h1>Active Agent Detail</h1>
      <p>Agent ID: <code>${escapeHtml(detail.agentId)}</code></p>
      <p>Active version: ${escapeHtml(detail.activeVersionId ?? "none")}</p>
    </section>
    <section class="card stack" data-visual-dynamic="overlay-state">
      <h2>Overlay State</h2>
      ${renderOverlaySummary("Agent overlay", detail.overlay.agent)}
      ${
        detail.overlay.environments.length === 0
          ? "<p>No environment overlays have been applied.</p>"
          : detail.overlay.environments
              .map((overlay) =>
                renderOverlaySummary(`Environment overlay for ${overlay.environmentKey}`, overlay),
              )
              .join("")
      }
      <div class="inline-actions">
        <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/overlay/deprecate" method="post">
          <button type="submit">Deprecate Agent</button>
        </form>
        <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/overlay/disable" method="post">
          <button class="button-secondary" type="submit">Disable Agent</button>
        </form>
      </div>
    </section>
    <section class="card stack" data-visual-dynamic="active-publications">
      <h2>Active Publications</h2>
      ${activePublicationMarkup}
    </section>
    <section class="card stack">
      <h2>Version History</h2>
      <div class="link-list" data-visual-dynamic="version-history">
        ${detail.versions.map((version) => `<a href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version.versionId)}">Version ${version.versionSequence} (${escapeHtml(version.approvalState)})</a>`).join("")}
      </div>
    </section>`,
    page: "active-agent-detail",
    principal,
    title: "Active Agent Detail",
  });
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

      if (pathname.startsWith("/assets/")) {
        const asset = resolveStaticAsset(pathname);

        if (asset === null) {
          writeError(response, 404, "Asset not found.");
          return;
        }

        if (request.method === "GET" || request.method === "HEAD") {
          writeStaticAsset(response, request.method, asset);
          return;
        }

        writeError(response, 404, "Asset not found.");
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
