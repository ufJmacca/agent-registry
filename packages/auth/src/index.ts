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

export class PrincipalResolver {
  private readonly membershipLookup: TenantMembershipLookup;

  constructor(membershipLookup: TenantMembershipLookup) {
    this.membershipLookup = membershipLookup;
  }

  async resolve(request: AuthenticatedRequestLike): Promise<ResolvedPrincipal> {
    const subjectId = request.auth?.subjectId?.trim();

    if (!subjectId) {
      throw new Error("Authenticated request is missing a subjectId");
    }

    const membership = await this.membershipLookup.getMembership(request.tenantId, subjectId);

    if (membership === null) {
      throw new Error(
        `Authenticated subject '${subjectId}' does not have tenant membership for '${request.tenantId}'`,
      );
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
