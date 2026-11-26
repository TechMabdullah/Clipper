import crypto from 'node:crypto';
import { getAdminDb, isFirebaseAdminConfigured } from './firebase-admin';
import type { Role } from './rbac';

export interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPct: number;
  targetRoles: Role[];
  updatedAt: number;
  updatedBy: string;
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlag[] = [
  {
    key: 'live_facecam_split',
    description: 'AI BlazeFace split-screen facecam vertical export during live recording',
    enabled: true,
    rolloutPct: 100,
    targetRoles: ['customer', 'support', 'admin', 'superadmin'],
    updatedAt: 0,
    updatedBy: 'system',
  },
  {
    key: 'ab_title_experiments',
    description: 'A/B title & hook generator variants on saved clips',
    enabled: true,
    rolloutPct: 100,
    targetRoles: ['customer', 'support', 'admin', 'superadmin'],
    updatedAt: 0,
    updatedBy: 'system',
  },
  {
    key: 'batch_social_queue',
    description: 'Automated YouTube Shorts / TikTok / Reels upload scheduler',
    enabled: true,
    rolloutPct: 100,
    targetRoles: ['customer', 'support', 'admin', 'superadmin'],
    updatedAt: 0,
    updatedBy: 'system',
  },
  {
    key: 'admin_maintenance_banner',
    description: 'Display scheduled maintenance notice across customer workspace',
    enabled: false,
    rolloutPct: 0,
    targetRoles: ['customer', 'support', 'admin', 'superadmin'],
    updatedAt: 0,
    updatedBy: 'system',
  },
];

export function computeUserRolloutBucket(flagKey: string, userId: string): number {
  const digest = crypto.createHash('sha256').update(`${flagKey}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function evaluateFeatureFlag(
  flag: Pick<FeatureFlag, 'key' | 'enabled' | 'rolloutPct' | 'targetRoles'>,
  userId: string,
  role: Role,
): boolean {
  if (!flag.enabled) return false;
  if (flag.targetRoles.length > 0 && !flag.targetRoles.includes(role)) {
    return false;
  }
  const pct = Math.max(0, Math.min(100, Math.round(flag.rolloutPct)));
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return computeUserRolloutBucket(flag.key, userId) < pct;
}

export async function getAllFeatureFlags(): Promise<FeatureFlag[]> {
  const byKey = new Map<string, FeatureFlag>(DEFAULT_FEATURE_FLAGS.map((f) => [f.key, f]));
  if (!isFirebaseAdminConfigured()) {
    return Array.from(byKey.values());
  }

  try {
    const snap = await getAdminDb().collection('feature_flags').get();
    for (const doc of snap.docs) {
      const data = doc.data();
      byKey.set(doc.id, {
        key: doc.id,
        description: String(data.description ?? ''),
        enabled: Boolean(data.enabled),
        rolloutPct: typeof data.rolloutPct === 'number' ? data.rolloutPct : 100,
        targetRoles: Array.isArray(data.targetRoles) ? (data.targetRoles as Role[]) : [],
        updatedAt: Number(data.updatedAt ?? 0),
        updatedBy: String(data.updatedBy ?? 'system'),
      });
    }
  } catch {
    // Return defaults if Firestore is unreachable or uninitialized
  }

  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export async function getMaintenanceState(): Promise<{ enabled: boolean; message: string }> {
  if (!isFirebaseAdminConfigured()) {
    return { enabled: false, message: '' };
  }
  try {
    const snap = await getAdminDb().collection('settings').doc('maintenance').get();
    const data = snap.data();
    return {
      enabled: Boolean(data?.enabled),
      message: String(data?.message ?? ''),
    };
  } catch {
    return { enabled: false, message: '' };
  }
}
