import { PrincipalResolver } from "@agent-registry/auth";
import { KyselyTenantMembershipLookup, type AgentRegistryDb } from "@agent-registry/db";

export function createPrincipalResolver(db: AgentRegistryDb): PrincipalResolver {
  return new PrincipalResolver(new KyselyTenantMembershipLookup(db));
}
