import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { AppShell } from '@/components/layout/app-shell';

export const dynamic = 'force-dynamic';

export default async function CustomerAppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect('/login');
  }

  return (
    <AppShell
      surface="customer"
      user={{
        uid: session.uid,
        email: session.email,
        name: session.name,
        picture: session.picture,
        role: session.role,
      }}
    >
      {children}
    </AppShell>
  );
}
