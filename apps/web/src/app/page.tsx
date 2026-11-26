import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdminSurfaceRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getSession();
  if (!session) {
    redirect('/login');
  }
  if (isAdminSurfaceRole(session.role)) {
    redirect('/admin/overview');
  }
  redirect('/overview');
}
