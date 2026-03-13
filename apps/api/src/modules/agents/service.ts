import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import {
  maxRawCardBytes,
  normalizeAgentCard,
  UnknownCardProfileError,
  InvalidAgentCardError,
} from "@agent-registry/agent-card";
import {
  contextContractTypes,
  isValidTenantEnvironmentKey,
  type ContextContractEntry,
  type CreateDraftAgentRequest,
  type CreateDraftVersionRequest,
  type DraftAgentRegistrationResponse,
  type DraftEnvironmentPublicationRequest,
  type HeaderContractEntry,
} from "@agent-registry/contracts";
import {
  AgentDraftNotFoundError,
  type AgentDraftRegistrationRepository,
  type DraftPublicationPersistenceInput,
  type TenantEnvironmentCatalogRepository,
  type TenantRepository,
} from "@agent-registry/db";

export interface AgentDraftRegistrationServiceOptions {
  deploymentMode?: "hosted" | "self-hosted";
  rawCardByteLimit?: number;
  requireHttpsHealthEndpoints?: boolean;
}

export class AgentDraftRegistrationAuthorizationError extends Error {}

export class AgentDraftRegistrationValidationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentDraftRegistrationAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertPublisherAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["publisher", "tenant-admin"])) {
    throw new AgentDraftRegistrationAuthorizationError(
      "Publisher role is required to create draft agent registrations.",
    );
  }
}

function assertNonEmptyString(
  value: unknown,
  fieldName: string,
  options: {
    trim?: boolean;
  } = {},
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentDraftRegistrationValidationError(`${fieldName} must be a non-empty string.`);
  }

  return options.trim === false ? value : value.trim();
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new AgentDraftRegistrationValidationError(`${fieldName} must be an array of strings.`);
  }

  const entries = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new AgentDraftRegistrationValidationError(
        `${fieldName} must contain only non-empty strings.`,
      );
    }

    return entry.trim();
  });

  return [...new Set(entries)];
}

function normalizeHeaderContract(value: unknown): HeaderContractEntry[] {
  if (!Array.isArray(value)) {
    throw new AgentDraftRegistrationValidationError(
      "Header contract must be an array of well-formed entries.",
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AgentDraftRegistrationValidationError(
        `Header contract entry ${index} must be an object.`,
      );
    }

    const record = entry as Record<string, unknown>;

    return {
      description: assertNonEmptyString(
        record.description,
        `Header contract entry ${index} description`,
      ),
      name: assertNonEmptyString(record.name, `Header contract entry ${index} name`),
      required: (() => {
        if (typeof record.required !== "boolean") {
          throw new AgentDraftRegistrationValidationError(
            `Header contract entry ${index} required flag must be a boolean.`,
          );
        }

        return record.required;
      })(),
      source: assertNonEmptyString(record.source, `Header contract entry ${index} source`),
    };
  });
}

function normalizeContextContract(value: unknown): ContextContractEntry[] {
  if (!Array.isArray(value)) {
    throw new AgentDraftRegistrationValidationError(
      "Context contract must be an array of well-formed entries.",
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AgentDraftRegistrationValidationError(
        `Context contract entry ${index} must be an object.`,
      );
    }

    const record = entry as Record<string, unknown>;
    const type = assertNonEmptyString(record.type, `Context contract entry ${index} type`);

    if (!contextContractTypes.includes(type as ContextContractEntry["type"])) {
      throw new AgentDraftRegistrationValidationError(
        `Context contract entry ${index} type must be one of ${contextContractTypes.join(", ")}.`,
      );
    }

    return {
      description: assertNonEmptyString(
        record.description,
        `Context contract entry ${index} description`,
      ),
      example: record.example,
      key: assertNonEmptyString(record.key, `Context contract entry ${index} key`),
      required: (() => {
        if (typeof record.required !== "boolean") {
          throw new AgentDraftRegistrationValidationError(
            `Context contract entry ${index} required flag must be a boolean.`,
          );
        }

        return record.required;
      })(),
      type: type as ContextContractEntry["type"],
    };
  });
}

function sortUniqueStrings(...values: string[][]): string[] {
  return [...new Set(values.flat())].sort();
}

function validateHealthEndpoint(
  value: unknown,
  options: {
    deploymentMode: "hosted" | "self-hosted";
    requireHttpsHealthEndpoints: boolean;
  },
): string {
  const endpoint = assertNonEmptyString(value, "healthEndpointUrl");
  let parsed: URL;

  try {
    parsed = new URL(endpoint);
  } catch {
    throw new AgentDraftRegistrationValidationError(
      "Each publication must include a valid health endpoint URL.",
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new AgentDraftRegistrationValidationError(
      "Health endpoint URLs must not contain embedded credentials.",
    );
  }

  if (options.requireHttpsHealthEndpoints && parsed.protocol !== "https:") {
    throw new AgentDraftRegistrationValidationError(
      `Hosted deployments require HTTPS health endpoints; received '${endpoint}'.`,
    );
  }

  if (
    options.deploymentMode === "hosted" &&
    parsed.protocol !== "https:" &&
    options.requireHttpsHealthEndpoints
  ) {
    throw new AgentDraftRegistrationValidationError(
      `Hosted deployments require HTTPS health endpoints; received '${endpoint}'.`,
    );
  }

  return parsed.toString();
}

function normalizeInvocationEndpoint(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return assertNonEmptyString(value, fieldName);
}

interface ValidatedDraftRegistration {
  capabilities: string[];
  cardProfileId: string;
  contextContract: ContextContractEntry[];
  displayName: string;
  headerContract: HeaderContractEntry[];
  publications: DraftPublicationPersistenceInput[];
  requiredRoles: string[];
  requiredScopes: string[];
  summary: string;
  tags: string[];
  versionLabel: string;
}

export class AgentDraftRegistrationService {
  private readonly deploymentMode: "hosted" | "self-hosted";

  private readonly draftRepository: AgentDraftRegistrationRepository;

  private readonly environmentRepository: TenantEnvironmentCatalogRepository;

  private readonly rawCardByteLimit: number;

  private readonly requireHttpsHealthEndpoints: boolean;

  private readonly tenantRepository: TenantRepository;

  constructor(
    draftRepository: AgentDraftRegistrationRepository,
    environmentRepository: TenantEnvironmentCatalogRepository,
    tenantRepository: TenantRepository,
    options: AgentDraftRegistrationServiceOptions = {},
  ) {
    this.deploymentMode = options.deploymentMode ?? "hosted";
    this.draftRepository = draftRepository;
    this.environmentRepository = environmentRepository;
    this.rawCardByteLimit = options.rawCardByteLimit ?? maxRawCardBytes;
    this.requireHttpsHealthEndpoints = options.requireHttpsHealthEndpoints ?? true;
    this.tenantRepository = tenantRepository;
  }

  async createDraftAgent(
    principal: ResolvedPrincipal,
    tenantId: string,
    request: CreateDraftAgentRequest,
  ): Promise<DraftAgentRegistrationResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertPublisherAccess(principal);

    const validated = await this.validateRequest(tenantId, request);
    const record = await this.draftRepository.createDraftAgent({
      ...validated,
      tenantId,
    });

    return {
      agentId: record.agentId,
      approvalState: "draft",
      cardProfileId: record.cardProfileId,
      publications: record.publications,
      versionId: record.versionId,
      versionSequence: record.versionSequence,
    };
  }

  async createDraftVersion(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    request: CreateDraftVersionRequest,
  ): Promise<DraftAgentRegistrationResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertPublisherAccess(principal);

    const validated = await this.validateRequest(tenantId, request);
    const record = await this.draftRepository.createDraftVersion({
      ...validated,
      agentId,
      tenantId,
    });

    return {
      agentId: record.agentId,
      approvalState: "draft",
      cardProfileId: record.cardProfileId,
      publications: record.publications,
      versionId: record.versionId,
      versionSequence: record.versionSequence,
    };
  }

  private async validateRequest(
    tenantId: string,
    request: CreateDraftAgentRequest | CreateDraftVersionRequest,
  ): Promise<ValidatedDraftRegistration> {
    const versionLabel = assertNonEmptyString(request.versionLabel, "versionLabel");
    const displayName = assertNonEmptyString(request.displayName, "displayName");
    const summary = assertNonEmptyString(request.summary, "summary");
    const capabilities = assertStringArray(request.capabilities, "capabilities");
    const tags = assertStringArray(request.tags, "tags");
    const requiredRoles = assertStringArray(request.requiredRoles, "requiredRoles");
    const requiredScopes = assertStringArray(request.requiredScopes, "requiredScopes");
    const headerContract = normalizeHeaderContract(request.headerContract);
    const contextContract = normalizeContextContract(request.contextContract);
    const [tenant, tenantEnvironmentList] = await Promise.all([
      this.tenantRepository.getById(tenantId),
      this.environmentRepository.listForTenant(tenantId),
    ]);

    if (tenant === null) {
      throw new AgentDraftRegistrationValidationError(
        `Tenant '${tenantId}' is not configured for draft registration.`,
      );
    }

    const cardProfileId =
      request.cardProfileId === undefined
        ? tenant.defaultCardProfileId
        : assertNonEmptyString(request.cardProfileId, "cardProfileId");

    if (!Array.isArray(request.publications) || request.publications.length === 0) {
      throw new AgentDraftRegistrationValidationError(
        "Draft registrations require at least one environment publication.",
      );
    }

    const tenantEnvironments = new Set(
      tenantEnvironmentList.map((environment) => environment.environmentKey),
    );
    const seenEnvironmentKeys = new Set<string>();
    const publications = request.publications.map((publication, index) =>
      this.validatePublication(
        publication,
        index,
        {
          capabilities,
          cardProfileId,
          displayName,
          summary,
          tags,
        },
        {
          seenEnvironmentKeys,
          tenantEnvironments,
        },
      ),
    );

    return {
      capabilities,
      cardProfileId,
      contextContract,
      displayName,
      headerContract,
      publications,
      requiredRoles,
      requiredScopes,
      summary,
      tags,
      versionLabel,
    };
  }

  private validatePublication(
    publication: DraftEnvironmentPublicationRequest,
    index: number,
    shared: {
      capabilities: string[];
      cardProfileId: string;
      displayName: string;
      summary: string;
      tags: string[];
    },
    constraints: {
      seenEnvironmentKeys: Set<string>;
      tenantEnvironments: Set<string>;
    },
  ): DraftPublicationPersistenceInput {
    const environmentKey = assertNonEmptyString(
      publication.environmentKey,
      `publications[${index}].environmentKey`,
    );

    if (!isValidTenantEnvironmentKey(environmentKey)) {
      throw new AgentDraftRegistrationValidationError(
        `Publication environment key '${environmentKey}' is not valid.`,
      );
    }

    if (constraints.seenEnvironmentKeys.has(environmentKey)) {
      throw new AgentDraftRegistrationValidationError(
        `Duplicate environment key '${environmentKey}' was provided in the draft registration.`,
      );
    }

    constraints.seenEnvironmentKeys.add(environmentKey);

    if (!constraints.tenantEnvironments.has(environmentKey)) {
      throw new AgentDraftRegistrationValidationError(
        `Unknown tenant environment '${environmentKey}' cannot be used in this draft registration.`,
      );
    }

    const rawCard = assertNonEmptyString(
      publication.rawCard,
      `publications[${index}].rawCard`,
      { trim: false },
    );

    if (Buffer.byteLength(rawCard, "utf8") > this.rawCardByteLimit) {
      throw new AgentDraftRegistrationValidationError(
        `Raw card exceeds the ${this.rawCardByteLimit} byte limit.`,
      );
    }

    const healthEndpointUrl = validateHealthEndpoint(publication.healthEndpointUrl, {
      deploymentMode: this.deploymentMode,
      requireHttpsHealthEndpoints: this.requireHttpsHealthEndpoints,
    });
    const invocationOverride = normalizeInvocationEndpoint(
      publication.invocationEndpoint,
      `publications[${index}].invocationEndpoint`,
    );

    try {
      const normalizedCard = normalizeAgentCard(rawCard, {
        cardProfileId: shared.cardProfileId,
      });

      if (normalizedCard.displayName !== shared.displayName) {
        throw new AgentDraftRegistrationValidationError(
          `Normalized displayName '${normalizedCard.displayName}' conflicts with shared displayName '${shared.displayName}'.`,
        );
      }

      if (normalizedCard.summary !== shared.summary) {
        throw new AgentDraftRegistrationValidationError(
          `Normalized summary '${normalizedCard.summary}' conflicts with shared summary '${shared.summary}'.`,
        );
      }

      if (
        invocationOverride !== undefined &&
        normalizedCard.invocationEndpoint !== null &&
        invocationOverride !== normalizedCard.invocationEndpoint
      ) {
        throw new AgentDraftRegistrationValidationError(
          `Publication '${environmentKey}' has conflicting invocation endpoint metadata.`,
        );
      }

      const invocationEndpoint = invocationOverride ?? normalizedCard.invocationEndpoint;

      if (invocationEndpoint === null || invocationEndpoint === undefined) {
        throw new AgentDraftRegistrationValidationError(
          `Publication '${environmentKey}' must provide an invocation endpoint in the card or request.`,
        );
      }

      return {
        environmentKey,
        healthEndpointUrl,
        invocationEndpoint,
        normalizedMetadata: {
          capabilities: sortUniqueStrings(normalizedCard.capabilities, shared.capabilities),
          cardProfileId: shared.cardProfileId,
          displayName: shared.displayName,
          invocationEndpoint,
          summary: shared.summary,
          tags: sortUniqueStrings(normalizedCard.tags, shared.tags),
        },
        rawCard,
      };
    } catch (error) {
      if (error instanceof AgentDraftRegistrationValidationError) {
        throw error;
      }

      if (error instanceof UnknownCardProfileError) {
        throw new AgentDraftRegistrationValidationError(error.message);
      }

      if (error instanceof InvalidAgentCardError) {
        throw new AgentDraftRegistrationValidationError(error.message);
      }

      throw error;
    }
  }
}

export { AgentDraftNotFoundError };
