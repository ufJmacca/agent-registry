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
        `<section class="card stack">
          <h2>Console Setup Pending</h2>
          <p>Run migrations and load bootstrap tenant data to enable console sign-in.</p>
        </section>`,
      );
      return;
    }

    throw error;
  }

  if (tenants.length === 0) {
    writeConsoleHomePage(
      response,
      `<section class="card stack">
        <h2>Console Setup Pending</h2>
        <p>Bootstrap tenant and membership data to enable console sign-in.</p>
      </section>`,
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

  writeConsoleHomePage(
    response,
    `<section class="card stack">
      <h2>Mock Sign-In</h2>
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

  writeHtml(
    response,
    200,
    {
      body: `<section class="hero card stack">
      <h1>Console Dashboard</h1>
      <p class="meta">${escapeHtml(tenantDisplayName)} (${escapeHtml(principal.tenantId)})</p>
      <p>Signed in as <strong>${escapeHtml(principal.subjectId)}</strong> with roles <strong>${escapeHtml(principal.roles.join(", ") || "none")}</strong>.</p>
      <div class="inline-actions">
        ${
          canPublish(principal)
            ? `<a class="pill" href="/tenants/${encodeURIComponent(principal.tenantId)}/drafts/new">New Draft Registration</a>`
            : ""
        }
        ${
          isTenantAdmin(principal)
            ? `<a class="pill" href="/tenants/${encodeURIComponent(principal.tenantId)}/environments">Environment Management</a>
               <a class="pill" href="/tenants/${encodeURIComponent(principal.tenantId)}/review">Review Queue</a>`
            : ""
        }
      </div>
    </section>
    <section class="split">
      <div class="card stack">
        <h2>Visible Versions</h2>
        <div class="link-list">
          ${
            versions.length === 0
              ? "<p>No versions are visible for this identity.</p>"
              : versions
                  .map(
                    (version) =>
                      `<a href="/tenants/${encodeURIComponent(principal.tenantId)}/agents/${encodeURIComponent(version.agentId)}/versions/${encodeURIComponent(version.versionId)}">${escapeHtml(version.displayName)} v${version.versionSequence} (${escapeHtml(version.approvalState)})</a>`,
                  )
                  .join("")
          }
        </div>
      </div>
      ${
        isTenantAdmin(principal)
          ? `<div class="card stack">
               <h2>Active Agents</h2>
               <div class="link-list">
                 ${
                   activeAgents.length === 0
                     ? "<p>No active approved agents yet.</p>"
                     : activeAgents
                         .map(
                           (agent) =>
                             `<a href="/tenants/${encodeURIComponent(principal.tenantId)}/agents/${encodeURIComponent(agent.agentId)}">${escapeHtml(agent.displayName)}</a>`,
                         )
                         .join("")
                }
               </div>
             </div>`
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

  writeHtml(
    response,
    200,
    {
      body: `<section class="hero card stack">
      <h1>Environment Management</h1>
      <p class="meta">Tenant ${escapeHtml(tenantId)}</p>
      <p><a href="/console">Back to dashboard</a></p>
    </section>
    <section class="split">
      <div class="card stack">
        <h2>Configured Environments</h2>
        <div class="section-list">
          ${environments.environments.map((environment) => `<div class="pill">${escapeHtml(environment.environmentKey)}</div>`).join("")}
        </div>
      </div>
      <div class="card stack">
        <h2>Add Environment</h2>
        ${renderEnvironmentForm(tenantId)}
      </div>
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

  writeHtml(
    response,
    200,
    {
      body: `<section class="hero card stack">
      <h1>New Draft Registration</h1>
      <p class="meta">Create one immutable version snapshot with shared metadata and multiple environment-specific cards.</p>
      <p><a href="/console">Back to dashboard</a></p>
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
      <section class="stack">
        <h2>Environment Publications</h2>
        ${publicationFields}
      </section>
      <button type="submit">Create Draft</button>
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

  const queue = await listReviewQueue(db, tenantId);

  writeHtml(
    response,
    200,
    {
      body: `<section class="hero card stack">
      <h1>Review Queue</h1>
      <p class="meta">Pending versions for ${escapeHtml(tenantId)}</p>
      <p><a href="/console">Back to dashboard</a></p>
    </section>
    <section class="stack">
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
      currentNavigationKey: "review",
      pageId: "review-queue",
      principal,
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
