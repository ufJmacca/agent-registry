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
import { resolveStaticAsset, writeStaticAsset } from "./ui/assets.js";
import { escapeHtml, renderDocument, renderPreformattedJson } from "./ui/document.js";
import { renderDraftRegistrationPage } from "./ui/pages/draft-registration.js";
import {
  renderInteractiveSignInPage,
  renderMissingBootstrapSignInPage,
  renderMissingSchemaSignInPage,
} from "./ui/pages/sign-in.js";
import { renderVersionDetailPageBody } from "./ui/pages/version-detail.js";
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
  publisherId: string;
  submittedAt: string | null;
  versionId: string;
  versionLabel: string;
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
      writePublicPage(response, "Agent Registry", "sign-in", renderMissingSchemaSignInPage());
      return;
    }

    throw error;
  }

  if (tenants.length === 0) {
    writePublicPage(response, "Agent Registry", "sign-in", renderMissingBootstrapSignInPage());
    return;
  }

  if (tenants.every((tenant) => tenant.memberships.length === 0)) {
    writePublicPage(response, "Agent Registry", "sign-in", renderMissingBootstrapSignInPage());
    return;
  }

  const selfHostedTenant = tenants[0];
  const selectedHostedTenant =
    deploymentMode === "hosted"
      ? tenants.find((tenant) => tenant.tenantId === selectedHostedTenantId) ?? tenants[0]
      : selfHostedTenant;
  writePublicPage(
    response,
    "Agent Registry",
    "sign-in",
    renderInteractiveSignInPage({
      deploymentMode,
      selectedTenant: selectedHostedTenant,
      selfHostedTenant,
      tenants,
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
    body: `<section class="hero card stack page-hero">
      <span class="shell-eyebrow">System Overview</span>
      <h1>Console Dashboard</h1>
      <p class="meta">${escapeHtml(tenantDisplayName)} (${escapeHtml(principal.tenantId)})</p>
      <p>Track visible versions, role-sensitive entry points, and the current tenant workspace from one shared shell.</p>
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
        <div class="link-list" data-visual-dynamic="visible-versions">
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
               <div class="link-list" data-visual-dynamic="active-agents">
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
  return `<form class="environment-form" action="/tenants/${encodeURIComponent(tenantId)}/environments" method="post">
    <div class="environment-form__intro">
      <p>Register one environment key at a time so new publication targets appear without changing the existing environment flow.</p>
    </div>
    <label>Environment key
      <input name="environmentKey" placeholder="qa" />
    </label>
    <div class="environment-form__actions">
      <button type="submit">Add Environment</button>
      <p class="meta">Use short stable keys such as <code>qa</code>, <code>staging</code>, or <code>prod</code>.</p>
    </div>
  </form>`;
}

function renderEnvironmentInventory(
  environmentKeys: string[],
  state: "empty" | "populated",
): string {
  if (state === "empty") {
    return `<div class="environment-list" data-visual-dynamic="environment-list">
      <div class="environment-empty">
        <p>No environments have been configured yet.</p>
        <p class="meta">Add an environment to unlock publication targeting for this tenant.</p>
      </div>
    </div>`;
  }

  return `<div class="environment-list" data-visual-dynamic="environment-list">
    ${environmentKeys
      .map(
        (environmentKey, index) => `<article class="environment-entry">
          <div class="environment-entry__meta">
            <span class="shell-eyebrow">Environment ${String(index + 1).padStart(2, "0")}</span>
            <span class="pill">Tenant publication target</span>
          </div>
          <h3>${escapeHtml(environmentKey)}</h3>
          <p class="meta">Registered for truthful draft publication targeting and tenant operations.</p>
        </article>`,
      )
      .join("")}
  </div>`;
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
  const environmentKeys = environments.environments.map((environment) => environment.environmentKey);
  const state = environmentKeys.length === 0 ? "empty" : "populated";

  writeAuthenticatedPage(response, {
    body: `<div class="environment-page" data-environment-layout="management" data-environment-state="${state}">
      <section class="hero card stack page-hero environment-hero">
        <span class="shell-eyebrow">Tenant Operations</span>
        <h1>Environment Management</h1>
        <div class="environment-hero__meta">
          <p class="meta">Tenant ${escapeHtml(tenantId)}</p>
          <span class="pill">${environmentKeys.length} configured</span>
        </div>
        <p>Configured environments stay primary, while creation remains a secondary panel that preserves the existing POST target and redirect behavior.</p>
      </section>
      <section class="environment-layout">
        <section class="card stack environment-panel environment-panel--inventory" data-environment-panel="inventory" data-environment-state="${state}">
          <div class="environment-panel__header">
            <span class="shell-eyebrow">Configured Inventory</span>
            <h2>Configured Environments</h2>
            <p class="meta">Use this tenant record as the source of truth for where versions can be published.</p>
          </div>
          ${renderEnvironmentInventory(environmentKeys, state)}
        </section>
        <aside class="card stack environment-panel environment-panel--creation" data-environment-panel="creation">
          <div class="environment-panel__header">
            <span class="shell-eyebrow">Secondary Action</span>
            <h2>Add Environment</h2>
            <p class="meta">Create a new environment key without changing field names, POST targets, or redirect behavior.</p>
          </div>
          ${renderEnvironmentForm(tenantId)}
        </aside>
      </section>
    </div>`,
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

  writeAuthenticatedPage(response, {
    body: renderDraftRegistrationPage({
      environments: environments.environments,
      tenantId,
    }),
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
    .select([
      "agent_id",
      "display_name",
      "publisher_id",
      "submitted_at",
      "version_id",
      "version_label",
      "version_sequence",
    ])
    .where("tenant_id", "=", tenantId)
    .where("approval_state", "=", "pending_review")
    .orderBy("submitted_at", "desc")
    .orderBy("version_sequence", "desc")
    .execute();

  return rows.map((row) => ({
    agentId: row.agent_id,
    displayName: row.display_name,
    publisherId: row.publisher_id,
    submittedAt: row.submitted_at,
    versionId: row.version_id,
    versionLabel: row.version_label,
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
      <p>Approve or reject each submission directly from the queue while using version detail for the full technical dossier.</p>
    </section>
    <section class="review-queue stack" data-visual-dynamic="review-queue">
      ${
        queue.length === 0
          ? `<div class="card review-queue-empty"><p>No versions are awaiting review.</p></div>`
          : `<ol class="review-queue-list" aria-label="Pending versions awaiting review">
              ${queue
                .map(
                  (entry) =>
                    `<li class="review-queue-item card">
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
                    </li>`,
                )
                .join("")}
            </ol>`
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
    body: renderVersionDetailPageBody({
      actions,
      detail,
      healthByEnvironment,
      isTenantAdmin: isTenantAdmin(principal),
      tenantId,
    }),
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
  return `<article class="agent-detail-overlay-card stack">
    <h3>${escapeHtml(label)}</h3>
    <p>Deprecated: ${overlay.deprecated ? "yes" : "no"}</p>
    <p>Disabled: ${overlay.disabled ? "yes" : "no"}</p>
    <p>Required roles: ${escapeHtml(overlay.requiredRoles.join(", ") || "none")}</p>
    <p>Required scopes: ${escapeHtml(overlay.requiredScopes.join(", ") || "none")}</p>
  </article>`;
}

function humanizeConsoleState(value: string): string {
  return value
    .split(/[_-]/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
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
      ? `<div class="agent-detail-empty stack">
           <p>No active approved version is currently published.</p>
           <p class="meta">Approve a version to expose truthful publication health, endpoints, and per-environment controls.</p>
         </div>`
      : `<div class="agent-detail-publication-list">
           ${detail.activeVersion.publications
             .map(
               (publication) =>
                 `<article class="agent-detail-publication-card stack">
                   <div class="agent-detail-card-head">
                     <div class="stack">
                       <span class="shell-eyebrow">Environment Publication</span>
                       <h3>${escapeHtml(publication.environmentKey)}</h3>
                     </div>
                     <div class="pill">${escapeHtml(publication.healthStatus ?? "unknown")}</div>
                   </div>
                   <p class="meta">Version ${detail.activeVersion?.versionSequence ?? "n/a"} · ${escapeHtml(humanizeConsoleState(detail.activeVersion?.approvalState ?? "unknown"))}</p>
                   <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
                 </article>`,
             )
             .join("")}
         </div>`;
  const environmentControlMarkup =
    detail.activeVersion === null
      ? `<div class="agent-detail-empty stack">
           <p>No environment overlays can be applied until an approved version is active.</p>
           <p class="meta">Version history remains available while approval is pending.</p>
         </div>`
      : `<div class="agent-detail-control-list">
           ${detail.activeVersion.publications
             .map(
               (publication) =>
                 `<article class="agent-detail-control-card stack">
                   <div class="agent-detail-card-head">
                     <div class="stack">
                       <span class="shell-eyebrow">Environment Controls</span>
                       <h3>${escapeHtml(publication.environmentKey)}</h3>
                     </div>
                     <div class="pill">Health ${escapeHtml(publication.healthStatus ?? "unknown")}</div>
                   </div>
                   <p>Health endpoint: <code>${escapeHtml(publication.healthEndpointUrl)}</code></p>
                   <div class="inline-actions">
                     <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/deprecate" method="post">
                       <button type="submit">Deprecate Environment</button>
                     </form>
                     <form action="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/environments/${encodeURIComponent(publication.environmentKey)}/overlay/disable" method="post">
                       <button class="button-secondary" type="submit">Disable Environment</button>
                     </form>
                   </div>
                 </article>`,
             )
             .join("")}
         </div>`;
  const versionHistoryMarkup =
    detail.versions.length === 0
      ? `<div class="agent-detail-empty stack">
           <p>No versions have been registered for this agent yet.</p>
         </div>`
      : `<div class="agent-detail-history-list">
           ${[...detail.versions]
             .reverse()
             .map(
               (version) =>
                 `<a class="agent-detail-history-item" href="/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(version.versionId)}">
                   <span class="shell-eyebrow">Version ${version.versionSequence}</span>
                   <strong>${escapeHtml(humanizeConsoleState(version.approvalState))}</strong>
                   <span class="meta">${version.versionId === detail.activeVersionId ? "Current active technical dossier" : "Open technical dossier"}</span>
                 </a>`,
             )
             .join("")}
         </div>`;
  const environmentOverlayCount = detail.overlay.environments.length;
  const activePublicationCount = detail.activeVersion?.publications.length ?? 0;

  writeAuthenticatedPage(response, {
    body: `<section class="card stack page-hero agent-detail-hero" data-visual-dynamic="agent-overview">
      <div class="agent-detail-hero__lead">
        <div class="agent-detail-signal">
          <span class="agent-detail-signal__pulse" aria-hidden="true"></span>
          <span class="shell-eyebrow">Active Agent Dossier</span>
        </div>
        <h1>${escapeHtml(detail.agentId)}</h1>
        <p class="meta">Truthful overlay state, published environments, and version history stay visible inside the shared technical curator shell.</p>
      </div>
      <div class="agent-detail-stats" aria-label="Agent detail summary">
        <div class="agent-detail-stat">
          <span class="shell-eyebrow">Tenant</span>
          <strong>${escapeHtml(tenantId)}</strong>
        </div>
        <div class="agent-detail-stat">
          <span class="shell-eyebrow">Active Version</span>
          <strong>${escapeHtml(detail.activeVersionId ?? "none")}</strong>
        </div>
        <div class="agent-detail-stat">
          <span class="shell-eyebrow">Published Environments</span>
          <strong>${activePublicationCount}</strong>
        </div>
        <div class="agent-detail-stat">
          <span class="shell-eyebrow">Overlay Environments</span>
          <strong>${environmentOverlayCount}</strong>
        </div>
      </div>
      <div class="agent-detail-pill-row">
        <span class="pill">Version history ${detail.versions.length}</span>
        <span class="pill">Agent overlay ${detail.overlay.agent.disabled ? "disabled" : detail.overlay.agent.deprecated ? "deprecated" : "clear"}</span>
        <span class="pill">Publication state ${escapeHtml(detail.activeVersion === null ? "no approved version" : humanizeConsoleState(detail.activeVersion.approvalState))}</span>
      </div>
    </section>
    <div class="agent-detail-grid">
      <section class="card stack agent-detail-panel" data-visual-dynamic="active-publications">
        <span class="shell-eyebrow">Published Surface</span>
        <h2>Active Publications</h2>
        <p class="meta">Current approved publications are shown exactly as they exist today, with no synthetic environments or metrics.</p>
        ${activePublicationMarkup}
      </section>
      <div class="agent-detail-side">
        <section class="card stack agent-detail-panel" data-visual-dynamic="overlay-state">
          <span class="shell-eyebrow">Policy Surface</span>
          <h2>Overlay Controls</h2>
          <p class="meta">Agent-level overlays remain obvious here while environment-level overlay state stays truthful below.</p>
          ${renderOverlaySummary("Agent overlay", detail.overlay.agent)}
          ${
            detail.overlay.environments.length === 0
              ? `<div class="agent-detail-empty stack">
                   <p>No environment overlays have been applied.</p>
                 </div>`
              : `<div class="agent-detail-overlay-list">
                   ${detail.overlay.environments
                     .map((overlay) =>
                       renderOverlaySummary(`Environment overlay for ${overlay.environmentKey}`, overlay),
                     )
                     .join("")}
                 </div>`
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
        <section class="card stack agent-detail-panel" data-visual-dynamic="environment-controls">
          <span class="shell-eyebrow">Publication Actions</span>
          <h2>Environment Controls</h2>
          <p class="meta">Per-environment overlay actions continue to post to the current routes for each approved publication.</p>
          ${environmentControlMarkup}
        </section>
      </div>
    </div>
    <section class="card stack agent-detail-panel" data-visual-dynamic="version-history">
      <div class="agent-detail-section-head">
        <div class="stack">
          <span class="shell-eyebrow">Audit Trail</span>
          <h2>Version History</h2>
        </div>
        <p class="meta">Every version remains linked from the active detail page for direct dossier review.</p>
      </div>
      ${versionHistoryMarkup}
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
