'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { KeyRound, Laptop, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';
import { signOutClient } from '@/lib/firebase';

interface SessionDoc {
  sessionId: string;
  ip?: string;
  userAgent?: string;
  role?: string;
  createdAt?: number;
  current?: boolean;
}

export default function SessionsPage() {
  const router = useRouter();
  const { data, isLoading, refetch } = useQuery<{ sessions: SessionDoc[] }>({
    queryKey: ['auth-active-sessions'],
    queryFn: async () => {
      const res = await fetch('/api/auth/sessions', { cache: 'no-store' });
      return res.ok ? res.json() : { sessions: [] };
    },
  });

  const handleRevokeOne = async (sessionId: string, isCurrent?: boolean) => {
    await withLoader(async () => {
      const res = await fetch('/api/auth/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'single', sessionId }),
      });
      if (!res.ok) {
        toast.error('Could not revoke session.');
        return;
      }
      if (isCurrent) {
        await signOutClient();
        router.push('/login');
        return;
      }
      toast.success('Device session revoked.');
      await refetch();
    }, 'Revoking session…');
  };

  const handleRevokeAll = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/auth/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'all' }),
      });
      if (!res.ok) {
        toast.error('Could not revoke all sessions.');
        return;
      }
      await signOutClient();
      toast.success('All sessions & refresh tokens revoked. Please sign in again.');
      router.push('/login');
    }, 'Signing out across all devices…');
  };

  return (
    <PageTransition>
      <div className="space-y-6 max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Active Sessions & Devices
            </h1>
            <p className="text-sm text-muted-foreground">
              Audit signed-in browsers or immediately revoke Firebase refresh tokens everywhere.
            </p>
          </div>
          <Button variant="destructive" onClick={handleRevokeAll} className="rounded-[16px] font-bold gap-2">
            <LogOut className="h-4 w-4" /> Sign Out All Devices
          </Button>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonList items={4} />}>
          <div className="space-y-3">
            {(data?.sessions ?? []).length === 0 ? (
              <Card className="rounded-[24px] p-10 text-center text-sm text-muted-foreground">
                <KeyRound className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No session records stored yet.
              </Card>
            ) : (
              (data?.sessions ?? []).map((s) => (
                <Card
                  key={s.sessionId}
                  className="rounded-[20px] p-4 flex flex-wrap items-center justify-between gap-4 shadow-[var(--shadow-sm)]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-primary/12 text-primary shrink-0">
                      <Laptop className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-extrabold truncate max-w-md">
                          {s.userAgent || 'Browser Session'}
                        </p>
                        {s.current && <Badge className="text-[10px]">Current</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        IP {s.ip || '127.0.0.1'} · Role {s.role || 'customer'} ·{' '}
                        {s.createdAt ? formatDistanceToNow(s.createdAt, { addSuffix: true }) : ''}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleRevokeOne(s.sessionId, s.current)}
                    className="rounded-[12px] text-xs font-bold"
                  >
                    Revoke
                  </Button>
                </Card>
              ))
            )}
          </div>
        </MinReveal>
      </div>
    </PageTransition>
  );
}
