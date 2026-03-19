export interface CallerIdentity {
  roles: string[];
  scopes: string[];
  tenantId: string;
}

export interface AccessRequirementClause {
  requiredRoles: string[];
  requiredScopes: string[];
}

export interface AuthenticatedRequestLike {
  auth?: {
    subjectId?: string;
    userContext?: Record<string, unknown>;
  };
  tenantId: string;
}

export interface TenantMembership {
  registryCapabilities: string[];
  roles: string[];
  scopes: string[];
  subjectId: string;
  tenantId: string;
  userContext: Record<string, unknown>;
}

export interface ResolvedPrincipal extends TenantMembership {}

export interface TenantMembershipLookup {
  getMembership(tenantId: string, subjectId: string): Promise<TenantMembership | null>;
}

export class MissingSubjectIdError extends Error {
  constructor() {
    super("Authenticated request is missing a subjectId");
  }
}

export class MissingTenantMembershipError extends Error {
  readonly subjectId: string;

  readonly tenantId: string;

  constructor(subjectId: string, tenantId: string) {
    super(`Authenticated subject '${subjectId}' does not have tenant membership for '${tenantId}'`);
    this.subjectId = subjectId;
    this.tenantId = tenantId;
  }
}

export class PrincipalResolver {
  private readonly membershipLookup: TenantMembershipLookup;

  constructor(membershipLookup: TenantMembershipLookup) {
    this.membershipLookup = membershipLookup;
  }

  async resolve(request: AuthenticatedRequestLike): Promise<ResolvedPrincipal> {
    const subjectId = request.auth?.subjectId?.trim();

    if (!subjectId) {
      throw new MissingSubjectIdError();
    }

    const membership = await this.membershipLookup.getMembership(request.tenantId, subjectId);

    if (membership === null) {
      throw new MissingTenantMembershipError(subjectId, request.tenantId);
    }

    return {
      registryCapabilities: [...membership.registryCapabilities],
      roles: [...membership.roles],
      scopes: [...membership.scopes],
      subjectId: membership.subjectId,
      tenantId: membership.tenantId,
      userContext: {
        ...membership.userContext,
        ...(request.auth?.userContext ?? {}),
      },
    };
  }
}

export function hasAnyRole(callerRoles: string[], requiredRoles: string[]): boolean {
  if (requiredRoles.length === 0) {
    return true;
  }

  return requiredRoles.some((role) => callerRoles.includes(role));
}

export function hasAllScopes(callerScopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => callerScopes.includes(scope));
}

export function satisfiesAccessClauses(
  caller: Pick<CallerIdentity, "roles" | "scopes">,
  clauses: AccessRequirementClause[],
): boolean {
  return clauses.every(
    (clause) =>
      hasAnyRole(caller.roles, clause.requiredRoles) &&
      hasAllScopes(caller.scopes, clause.requiredScopes),
  );
}

function getPathValue(root: unknown, path: string[]): unknown {
  let current = root;

  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

export function resolveUserContextSource(
  userContext: Record<string, unknown>,
  source: string,
): unknown {
  const normalizedSource = source.trim();

  if (normalizedSource === "") {
    return undefined;
  }

  if (normalizedSource.startsWith("user.")) {
    const strippedValue = getPathValue(userContext, normalizedSource.slice(5).split("."));

    if (strippedValue !== undefined && strippedValue !== null) {
      return strippedValue;
    }
  }

  return getPathValue(userContext, normalizedSource.split("."));
}
