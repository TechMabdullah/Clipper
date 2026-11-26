'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonTable } from '@/components/skeletons';

interface AuditRow {
  id: string;
  actorEmail: string;
  actorRole: string;
  action: string;
  target: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  createdAtIso?: string;
}

export default function AdminAuditPage() {
  const [actionFilter, setActionFilter] = React.useState('');
  const [actorFilter, setActorFilter] = React.useState('');
  const [selectedLog, setSelectedLog] = React.useState<AuditRow | null>(null);

  const { data, isLoading } = useQuery<{ logs: AuditRow[] }>({
    queryKey: ['admin-audit-logs', actionFilter, actorFilter],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (actionFilter.trim()) qs.set('action', actionFilter.trim());
      if (actorFilter.trim()) qs.set('actor', actorFilter.trim());
      const res = await fetch(`/api/admin/audit?${qs.toString()}`, { cache: 'no-store' });
      return res.ok ? res.json() : { logs: [] };
    },
  });

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Immutable Audit Trail</h1>
            <p className="text-sm text-muted-foreground">
              Append-only record of auth events, role mutations, refunds, flags, and exports.
            </p>
          </div>
          <Button variant="outline" size="sm" className="rounded-[12px] gap-1.5 font-bold" asChild>
            <a href="/api/admin/export?resource=audit_logs">
              <Download className="h-3.5 w-3.5" /> Stream Safe CSV
            </a>
          </Button>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter action (e.g. admin.role)…"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="h-9 rounded-[12px] pl-9 text-xs"
            />
          </div>
          <Input
            placeholder="Filter actor email…"
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="h-9 max-w-xs rounded-[12px] text-xs"
          />
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonTable rows={8} cols={5} />}>
          <Card className="rounded-[20px] overflow-hidden shadow-[var(--shadow-sm)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Reason / IP</TableHead>
                  <TableHead className="text-right">Diff</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.logs ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-xs text-muted-foreground">
                      No audit logs matched or Firebase Admin is not configured yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  (data?.logs ?? []).map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono text-[11px]">{log.createdAtIso?.slice(0, 19) || '—'}</TableCell>
                      <TableCell>
                        <span className="font-bold">{log.actorEmail}</span>{' '}
                        <Badge variant="outline" className="text-[10px] ml-1">{log.actorRole}</Badge>
                      </TableCell>
                      <TableCell><Badge variant="secondary" className="font-mono text-[10px]">{log.action}</Badge></TableCell>
                      <TableCell className="font-mono text-[11px]">{log.target}</TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]">
                        {log.reason || log.ip}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setSelectedLog(log)}>
                          Inspect
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </MinReveal>

        <Sheet open={Boolean(selectedLog)} onOpenChange={(o) => !o && setSelectedLog(null)}>
          <SheetContent className="sm:max-w-lg overflow-y-auto" data-lenis-prevent>
            {selectedLog && (
              <div className="space-y-4">
                <SheetHeader>
                  <SheetTitle className="font-mono text-sm">{selectedLog.action}</SheetTitle>
                </SheetHeader>
                <div className="space-y-2 text-xs">
                  <p><strong>Actor:</strong> {selectedLog.actorEmail} ({selectedLog.actorRole})</p>
                  <p><strong>Target:</strong> {selectedLog.target}</p>
                  <p><strong>Reason:</strong> {selectedLog.reason || '—'}</p>
                  <div>
                    <p className="font-bold mb-1">Before:</p>
                    <pre className="rounded-[12px] bg-muted p-3 overflow-auto text-[11px]">
                      {JSON.stringify(selectedLog.before ?? null, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <p className="font-bold mb-1">After:</p>
                    <pre className="rounded-[12px] bg-muted p-3 overflow-auto text-[11px]">
                      {JSON.stringify(selectedLog.after ?? null, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </PageTransition>
  );
}
