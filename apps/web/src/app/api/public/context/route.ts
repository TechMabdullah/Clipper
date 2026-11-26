import { NextResponse } from 'next/server';
import { getAdminDb, isFirebaseAdminConfigured } from '@/lib/firebase-admin';
import { DEFAULT_FEATURE_FLAGS, getMaintenanceState, evaluateFeatureFlag } from '@/lib/flags';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  const maintenance = await getMaintenanceState();

  let announcements: Array<Record<string, unknown>> = [];
  let faqs: Array<Record<string, unknown>> = [];
  const evaluatedFlags: Record<string, boolean> = {};

  if (isFirebaseAdminConfigured()) {
    try {
      const db = getAdminDb();
      const [annSnap, faqSnap, flagSnap] = await Promise.all([
        db.collection('announcements').where('active', '==', true).limit(10).get(),
        db.collection('faq_items').limit(30).get(),
        db.collection('feature_flags').get(),
      ]);

      announcements = annSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      faqs = faqSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          Number(a.order ?? 0) - Number(b.order ?? 0),
        );

      const flagsMap = new Map(DEFAULT_FEATURE_FLAGS.map((f) => [f.key, f]));
      for (const doc of flagSnap.docs) {
        const d = doc.data();
        flagsMap.set(doc.id, {
          key: doc.id,
          description: String(d.description ?? ''),
          enabled: Boolean(d.enabled),
          rolloutPct: typeof d.rolloutPct === 'number' ? d.rolloutPct : 100,
          targetRoles: Array.isArray(d.targetRoles) ? d.targetRoles : ['customer'],
          updatedAt: Number(d.updatedAt ?? 0),
          updatedBy: String(d.updatedBy ?? 'system'),
        });
      }
      if (session) {
        for (const f of flagsMap.values()) {
          evaluatedFlags[f.key] = evaluateFeatureFlag(f, session.uid, session.role);
        }
      }
    } catch {
      // Fallback to empty public content cleanly
    }
  }

  return NextResponse.json({
    maintenance,
    announcements,
    faqs,
    flags: evaluatedFlags,
  });
}
