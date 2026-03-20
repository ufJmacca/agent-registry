import { randomUUID } from "node:crypto";

import type { AgentRegistryDb } from "../index.js";

export interface DraftPublicationPersistenceInput {
  environmentKey: string;
  healthEndpointUrl: string;
  invocationEndpoint: string;
  normalizedMetadata: Record<string, unknown>;
  rawCard: string;
}

export interface CreateDraftAgentInput {
  capabilities: string[];
  cardProfileId: string;
  contextContract: unknown[];
  displayName: string;
  headerContract: unknown[];
  publications: DraftPublicationPersistenceInput[];
  publisherId: string;
  requiredRoles: string[];
  requiredScopes: string[];
  summary: string;
  tags: string[];
  tenantId: string;
  versionLabel: string;
}

export interface CreateDraftVersionInput extends CreateDraftAgentInput {
  agentId: string;
}

export interface DraftPublicationRecord {
  environmentKey: string;
  publicationId: string;
}

export interface DraftRegistrationRecord {
  agentId: string;
  cardProfileId: string;
  publications: DraftPublicationRecord[];
  versionId: string;
  versionSequence: number;
}

export interface AgentDraftRegistrationRepository {
  createDraftAgent(input: CreateDraftAgentInput): Promise<DraftRegistrationRecord>;
  createDraftVersion(input: CreateDraftVersionInput): Promise<DraftRegistrationRecord>;
}

export class AgentDraftNotFoundError extends Error {
  readonly agentId: string;

  readonly tenantId: string;

  constructor(tenantId: string, agentId: string) {
    super(`Agent '${agentId}' does not exist for tenant '${tenantId}'.`);
    this.agentId = agentId;
    this.tenantId = tenantId;
  }
}

function buildPublicationRows(
  input: CreateDraftAgentInput | CreateDraftVersionInput,
  agentId: string,
  versionId: string,
): Array<{
  environment_key: string;
  health_endpoint_url: string;
  invocation_endpoint: string;
  normalized_metadata: Record<string, unknown>;
  publication_id: string;
  raw_card: string;
  tenant_id: string;
  version_id: string;
  agent_id: string;
}> {
  return input.publications.map((publication) => ({
    agent_id: agentId,
    environment_key: publication.environmentKey,
    health_endpoint_url: publication.healthEndpointUrl,
    invocation_endpoint: publication.invocationEndpoint,
    normalized_metadata: publication.normalizedMetadata,
    publication_id: randomUUID(),
    raw_card: publication.rawCard,
    tenant_id: input.tenantId,
    version_id: versionId,
  }));
}

async function insertVersion(
  db: AgentRegistryDb,
  input: CreateDraftAgentInput | CreateDraftVersionInput,
  agentId: string,
  versionId: string,
  versionSequence: number,
): Promise<void> {
  await db
    .insertInto("agent_versions")
    .values({
      agent_id: agentId,
      approval_state: "draft",
      capabilities: input.capabilities,
      card_profile_id: input.cardProfileId,
      context_contract: JSON.stringify(input.contextContract),
      display_name: input.displayName,
      header_contract: JSON.stringify(input.headerContract),
      publisher_id: input.publisherId,
      required_roles: input.requiredRoles,
      required_scopes: input.requiredScopes,
      summary: input.summary,
      tags: input.tags,
      tenant_id: input.tenantId,
      version_id: versionId,
      version_label: input.versionLabel,
      version_sequence: versionSequence,
    })
    .execute();
}

export class KyselyAgentDraftRegistrationRepository implements AgentDraftRegistrationRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async createDraftAgent(input: CreateDraftAgentInput): Promise<DraftRegistrationRecord> {
    return this.db.transaction().execute(async (transaction) => {
      const agentId = randomUUID();
      const versionId = randomUUID();
      const publicationRows = buildPublicationRows(input, agentId, versionId);

      await transaction
        .insertInto("agents")
        .values({
          active_version_id: null,
          agent_id: agentId,
          display_name: input.displayName,
          summary: input.summary,
          tenant_id: input.tenantId,
        })
        .execute();

      await insertVersion(transaction, input, agentId, versionId, 1);

      await transaction.insertInto("environment_publications").values(publicationRows).execute();

      return {
        agentId,
        cardProfileId: input.cardProfileId,
        publications: publicationRows.map((publication) => ({
          environmentKey: publication.environment_key,
          publicationId: publication.publication_id,
        })),
        versionId,
        versionSequence: 1,
      };
    });
  }

  async createDraftVersion(input: CreateDraftVersionInput): Promise<DraftRegistrationRecord> {
    return this.db.transaction().execute(async (transaction) => {
      const existingAgent = await transaction
        .selectFrom("agents")
        .select(["agent_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .forUpdate()
        .executeTakeFirst();

      if (existingAgent === undefined) {
        throw new AgentDraftNotFoundError(input.tenantId, input.agentId);
      }

      const latestVersion = await transaction
        .selectFrom("agent_versions")
        .select((expressionBuilder) =>
          expressionBuilder.fn.max<number>("version_sequence").as("max_version_sequence"),
        )
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .executeTakeFirst();
      const versionSequence = Number(latestVersion?.max_version_sequence ?? 0) + 1;
      const versionId = randomUUID();
      const publicationRows = buildPublicationRows(input, input.agentId, versionId);

      await insertVersion(transaction, input, input.agentId, versionId, versionSequence);

      await transaction.insertInto("environment_publications").values(publicationRows).execute();

      return {
        agentId: input.agentId,
        cardProfileId: input.cardProfileId,
        publications: publicationRows.map((publication) => ({
          environmentKey: publication.environment_key,
          publicationId: publication.publication_id,
        })),
        versionId,
        versionSequence,
      };
    });
  }
}
