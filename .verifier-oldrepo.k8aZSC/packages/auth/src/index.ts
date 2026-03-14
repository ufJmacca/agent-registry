export interface CallerIdentity {
  roles: string[];
  scopes: string[];
  tenantId: string;
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
