export interface CallerIdentity {
  roles: string[];
  scopes: string[];
  tenantId: string;
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
