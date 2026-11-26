import {
  ROLES,
  ROLE_PERMISSION_MAP,
  ROLE_RANK,
  type Permission,
  type Role,
} from './permissions';

export { ROLES, ROLE_PERMISSION_MAP, ROLE_RANK };
export type { Permission, Role };

export function normalizeRole(input: unknown): Role {
  if (typeof input === 'string') {
    const candidate = input.trim().toLowerCase();
    if ((ROLES as readonly string[]).includes(candidate)) {
      return candidate as Role;
    }
  }
  return 'customer';
}

export function hasRoleAtLeast(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function isAdminSurfaceRole(role: Role): boolean {
  return hasRoleAtLeast(role, 'support');
}

export function getPermissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSION_MAP[role]];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSION_MAP[role].includes(permission);
}
