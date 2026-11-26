export const ROLES = ['customer', 'support', 'admin', 'superadmin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'clipper:use',
  'clips:write',
  'collections:write',
  'billing:manage',
  'orders:read',
  'orders:refund',
  'support:read',
  'support:write',
  'users:read',
  'users:write',
  'flags:read',
  'flags:write',
  'content:write',
  'audit:read',
  'roles:write',
  'webhooks:write',
  'system:maintain',
  'admin:access',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_RANK: Record<Role, number> = {
  customer: 0,
  support: 1,
  admin: 2,
  superadmin: 3,
};

/**
 * Single source of truth for Role -> Permission mapping.
 * Both API guards and UI navigation/action visibility read exclusively from this map.
 */
export const ROLE_PERMISSION_MAP: Record<Role, readonly Permission[]> = {
  customer: [
    'clipper:use',
    'clips:write',
    'collections:write',
    'billing:manage',
  ],
  support: [
    'clipper:use',
    'clips:write',
    'collections:write',
    'billing:manage',
    'admin:access',
    'orders:read',
    'support:read',
    'support:write',
    'users:read',
    'flags:read',
    'audit:read',
  ],
  admin: [
    'clipper:use',
    'clips:write',
    'collections:write',
    'billing:manage',
    'admin:access',
    'orders:read',
    'orders:refund',
    'support:read',
    'support:write',
    'users:read',
    'users:write',
    'flags:read',
    'flags:write',
    'content:write',
    'audit:read',
    'webhooks:write',
  ],
  superadmin: [...PERMISSIONS],
};
