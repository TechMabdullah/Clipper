import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdminSurfaceRole } from '@/lib/rbac';
import { AppShell } from '@/components/layout/app-shell';
import { AdminTotpGate } from '@/components/auth/admin-totp-gate';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect('/login?next=/admin/overview');
  }
  if (!isAdminSurfaceRole(session.role)) {
    redirect('/overview');
  }

  return (
    <AppShell
      surface="admin"
      user={{
        uid: session.uid,
        email: session.email,
        name: session.name,
        picture: session.picture,
        role: session.role,
      }}
    >
      <AdminTotpGate needsTotp={session.totpEnabled && !session.totpVerified} />
      {children}
    </AppShell>
  );
}
