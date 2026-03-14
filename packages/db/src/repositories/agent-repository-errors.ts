export class AgentNotFoundError extends Error {
  readonly agentId: string;

  readonly tenantId: string;

  constructor(tenantId: string, agentId: string) {
    super(`Agent '${agentId}' does not exist for tenant '${tenantId}'.`);
    this.agentId = agentId;
    this.tenantId = tenantId;
  }
}

export class AgentVersionNotFoundError extends Error {
  readonly agentId: string;

  readonly tenantId: string;

  readonly versionId: string;

  constructor(tenantId: string, agentId: string, versionId: string) {
    super(`Version '${versionId}' does not exist for agent '${agentId}' in tenant '${tenantId}'.`);
    this.agentId = agentId;
    this.tenantId = tenantId;
    this.versionId = versionId;
  }
}

export class AgentVersionEnvironmentPublicationNotFoundError extends Error {
  readonly agentId: string;

  readonly environmentKey: string;

  readonly tenantId: string;

  readonly versionId: string;

  constructor(tenantId: string, agentId: string, versionId: string, environmentKey: string) {
    super(
      `Environment '${environmentKey}' does not exist on version '${versionId}' for agent '${agentId}' in tenant '${tenantId}'.`,
    );
    this.agentId = agentId;
    this.environmentKey = environmentKey;
    this.tenantId = tenantId;
    this.versionId = versionId;
  }
}

export class AgentEnvironmentPublicationNotFoundError extends Error {
  readonly agentId: string;

  readonly environmentKey: string;

  readonly tenantId: string;

  constructor(tenantId: string, agentId: string, environmentKey: string) {
    super(
      `Environment '${environmentKey}' does not exist on the active approved version for agent '${agentId}' in tenant '${tenantId}'.`,
    );
    this.agentId = agentId;
    this.environmentKey = environmentKey;
    this.tenantId = tenantId;
  }
}
