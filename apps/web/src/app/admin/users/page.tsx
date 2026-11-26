'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, Search, Shield, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonTable } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

interface AdminUserRow {
  uid: string;
  email: string;
  name?: string;
  role: string;
  plan?: string;
  disabled?: boolean;
  lastLoginAt?: number;
}

export default function AdminUsersPage() {
  const [search, setSearch] = React.useState('');
  const [roleView, setRoleView] = React.useState('all');
  const [showPlanCol, setShowPlanCol] = React.useState(true);
  const [selectedUids, setSelectedUids] = React.useState<string[]>([]);
  const [activeUser, setActiveUser] = React.useState<AdminUserRow | null>(null);
  const [reason, setReason] = React.useState('');
  const [nextRole, setNextRole] = React.useState('customer');

  const scrollParentRef = React.useRef<HTMLDivElement | null>(null);

  const { data, isLoading, refetch } = useQuery<{ users: AdminUserRow[] }>({
    queryKey: ['admin-users', search, roleView],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('q', search.trim());
      if (roleView !== 'all') qs.set('role', roleView);
      const res = await fetch(`/api/admin/users?${qs.toString()}`, { cache: 'no-store' });
      return res.ok ? res.json() : { users: [] };
    },
  });

  const users = data?.users ?? [];
  const rowVirtualizer = useVirtualizer({
    count: users.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 44,
    overscan: 8,
  });

  React.useEffect(() => {
    if (activeUser) {
      setNextRole(activeUser.role || 'customer');
      setReason('');
    }
  }, [activeUser]);

  const handleToggleDisable = async (u: AdminUserRow, disable: boolean) => {
    if (reason.trim().length < 3) {
      toast.error('Provide an audit reason (min 3 characters).');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: u.uid, disabled: disable, reason }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Action failed.');
        return;
      }
      toast.success(disable ? 'User disabled & sessions revoked.' : 'User re-enabled.');
      setActiveUser(null);
      await refetch();
    }, 'Updating account status…');
  };

  const handleChangeRole = async (u: AdminUserRow) => {
    if (reason.trim().length < 3) {
      toast.error('Provide an audit reason for role change.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/admin/roles', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: u.uid, role: nextRole, reason }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Only superadmin can change roles.');
        return;
      }
      toast.success(`Role updated to ${nextRole} & refresh tokens revoked.`);
      setActiveUser(null);
      await refetch();
    }, 'Updating user role & revoking tokens…');
  };

  const handleBulkRevoke = async () => {
    if (selectedUids.length === 0) return;
    await withLoader(async () => {
      for (const uid of selectedUids) {
        await fetch('/api/admin/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, revokeSessions: true, reason: 'Bulk admin session revocation' }),
        });
      }
      toast.success(`Revoked active sessions for ${selectedUids.length} user(s).`);
      setSelectedUids([]);
      await refetch();
    }, 'Revoking sessions across selected accounts…');
  };

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Users & Roles Directory</h1>
            <p className="text-sm text-muted-foreground">
              Virtualized directory with saved role views, token revocation, and audited RBAC elevation.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedUids.length > 0 && (
              <Button variant="destructive" size="sm" onClick={handleBulkRevoke} className="rounded-[12px] font-bold">
                Revoke Sessions ({selectedUids.length})
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setShowPlanCol((v) => !v)} className="rounded-[12px]">
              {showPlanCol ? 'Hide Plan Col' : 'Show Plan Col'}
            </Button>
            <Button variant="outline" size="sm" className="rounded-[12px] gap-1.5" asChild>
              <a href="/api/admin/export?resource=users">
                <Download className="h-3.5 w-3.5" /> Export CSV
              </a>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search email, UID, handle…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 rounded-[14px] pl-10"
            />
          </div>
          {['all', 'customer', 'support', 'admin', 'superadmin'].map((rv) => (
            <Button
              key={rv}
              size="sm"
              variant={roleView === rv ? 'default' : 'outline'}
              onClick={() => setRoleView(rv)}
              className="rounded-full capitalize text-xs font-bold"
            >
              {rv}
            </Button>
          ))}
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonTable rows={8} cols={5} />}>
          <Card className="rounded-[20px] overflow-hidden shadow-[var(--shadow-sm)]">
            <div className="grid grid-cols-12 items-center border-b border-border bg-muted/45 px-4 py-2.5 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
              <div className="col-span-1">Sel</div>
              <div className="col-span-4">Email & Name</div>
              <div className="col-span-2">Role</div>
              {showPlanCol && <div className="col-span-2">Plan</div>}
              <div className="col-span-2">Status</div>
              <div className="col-span-1 text-right">Edit</div>
            </div>

            <div ref={scrollParentRef} className="h-[460px] overflow-auto">
              {users.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  No users found in Firestore yet. Sign in via `/login` to populate users!
                </div>
              ) : (
                <div
                  style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
                >
                  {rowVirtualizer.getVirtualItems().map((vRow) => {
                    const u = users[vRow.index];
                    if (!u) return null;
                    const checked = selectedUids.includes(u.uid);
                    return (
                      <div
                        key={u.uid}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${vRow.size}px`,
                          transform: `translateY(${vRow.start}px)`,
                        }}
                        className="grid grid-cols-12 items-center border-b border-border/60 px-4 text-xs hover:bg-muted/35 transition"
                      >
                        <div className="col-span-1">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(c) =>
                              setSelectedUids((prev) =>
                                c ? [...prev, u.uid] : prev.filter((x) => x !== u.uid),
                              )
                            }
                          />
                        </div>
                        <div className="col-span-4 truncate pr-2">
                          <span className="font-bold text-foreground">{u.email}</span>
                          {u.name && <span className="ml-1.5 text-muted-foreground">({u.name})</span>}
                        </div>
                        <div className="col-span-2">
                          <Badge variant="secondary" className="text-[10px] uppercase">{u.role}</Badge>
                        </div>
                        {showPlanCol && (
                          <div className="col-span-2 font-mono uppercase text-[11px]">{u.plan || 'free'}</div>
                        )}
                        <div className="col-span-2">
                          <Badge variant={u.disabled ? 'destructive' : 'outline'} className="text-[10px]">
                            {u.disabled ? 'Disabled' : 'Active'}
                          </Badge>
                        </div>
                        <div className="col-span-1 text-right">
                          <Button size="sm" variant="ghost" className="h-7 text-xs font-bold" onClick={() => setActiveUser(u)}>
                            Inspect
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </MinReveal>

        <Sheet open={Boolean(activeUser)} onOpenChange={(o) => !o && setActiveUser(null)}>
          <SheetContent data-lenis-prevent>
            {activeUser && (
              <div className="space-y-5">
                <SheetHeader>
                  <SheetTitle className="font-extrabold">{activeUser.email}</SheetTitle>
                  <SheetDescription className="font-mono text-xs">UID: {activeUser.uid}</SheetDescription>
                </SheetHeader>

                <div className="space-y-1.5">
                  <Label className="text-xs font-bold">Audit Reason (required)</Label>
                  <Input
                    placeholder="Reason logged to immutable audit trail…"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="rounded-[12px]"
                  />
                </div>

                <div className="rounded-[16px] border border-border p-4 space-y-3">
                  <Label className="text-xs font-extrabold flex items-center gap-1.5">
                    <Shield className="h-3.5 w-3.5 text-primary" /> RBAC Role Assignment (Superadmin)
                  </Label>
                  <Select value={nextRole} onValueChange={setNextRole}>
                    <SelectTrigger className="rounded-[12px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer">customer</SelectItem>
                      <SelectItem value="support">support</SelectItem>
                      <SelectItem value="admin">admin</SelectItem>
                      <SelectItem value="superadmin">superadmin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => void handleChangeRole(activeUser)}
                    className="w-full rounded-[12px] font-bold"
                  >
                    Save Role & Revoke Tokens
                  </Button>
                </div>

                <div className="flex gap-2">
                  {activeUser.disabled ? (
                    <Button
                      variant="outline"
                      className="flex-1 rounded-[12px] gap-1.5"
                      onClick={() => void handleToggleDisable(activeUser, false)}
                    >
                      <UserCheck className="h-4 w-4 text-emerald-500" /> Re-Enable User
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      className="flex-1 rounded-[12px] gap-1.5"
                      onClick={() => void handleToggleDisable(activeUser, true)}
                    >
                      <UserX className="h-4 w-4" /> Disable & Revoke
                    </Button>
                  )}
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </PageTransition>
  );
}
