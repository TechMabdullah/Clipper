import { getAdminDb } from './firebase-admin';
import type { Role } from './rbac';

if (typeof window !== 'undefined') {
  throw new Error('audit.ts is server-only.');
}

export interface AuditEntryInput {
  actorUid: string;
  actorEmail: string;
  actorRole: Role | string;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  userAgent?: string;
}

function sanitizeValue(val: unknown): unknown {
  if (val === undefined) return null;
  if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return String(val);
  }
}

/**
 * Writes an immutable audit log entry to the append-only Firestore `audit_logs` collection.
 * Never throws so auditing issues don't mask caller status codes cleanly—errors are logged.
 */
export async function writeAuditLog(entry: AuditEntryInput): Promise<string | null> {
  try {
    const db = getAdminDb();
    const docRef = db.collection('audit_logs').doc();
    await docRef.set({
      id: docRef.id,
      actorUid: entry.actorUid,
      actorEmail: entry.actorEmail,
      actorRole: entry.actorRole,
      action: entry.action,
      target: entry.target,
      before: sanitizeValue(entry.before),
      after: sanitizeValue(entry.after),
      reason: entry.reason?.trim() ?? '',
      ip: entry.ip ?? 'unknown',
      userAgent: (entry.userAgent ?? '').slice(0, 300),
      createdAt: Date.now(),
      createdAtIso: new Date().toISOString(),
    });
    return docRef.id;
  } catch (err) {
    console.warn('[audit] Failed to write Firestore audit log:', err);
    return null;
  }
}
