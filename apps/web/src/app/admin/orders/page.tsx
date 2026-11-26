'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, KanbanSquare, TableProperties } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonTable } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

interface AdminOrder {
  id: string;
  email?: string;
  planName?: string;
  amountFormatted?: string;
  status: string;
  createdAtIso?: string;
}

const KANBAN_STATUSES = ['pending', 'paid', 'fulfilled', 'refunded'] as const;

export default function AdminOrdersPage() {
  const [viewMode, setViewMode] = React.useState<'table' | 'kanban'>('table');
  const [selectedOrder, setSelectedOrder] = React.useState<AdminOrder | null>(null);
  const [reason, setReason] = React.useState('');

  const { data, isLoading, refetch } = useQuery<{ orders: AdminOrder[] }>({
    queryKey: ['admin-orders'],
    queryFn: async () => {
      const res = await fetch('/api/admin/orders', { cache: 'no-store' });
      return res.ok ? res.json() : { orders: [] };
    },
  });

  const handleUpdateOrder = async (orderId: string, status: string) => {
    if (reason.trim().length < 3) {
      toast.error('Provide an audit reason for this order change.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/admin/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, status, reason }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Update failed.');
        return;
      }
      toast.success(`Order marked ${status}.`);
      setSelectedOrder(null);
      setReason('');
      await refetch();
    }, 'Updating order & writing audit log…');
  };

  const orders = data?.orders ?? [];

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Orders, Refunds & Fulfillment</h1>
            <p className="text-sm text-muted-foreground">
              Manage SaaS subscription fulfillment stages, issue audited refunds, or export accounting CSVs.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={viewMode === 'table' ? 'default' : 'outline'}
              onClick={() => setViewMode('table')}
              className="rounded-[12px] gap-1.5"
            >
              <TableProperties className="h-3.5 w-3.5" /> Table
            </Button>
            <Button
              size="sm"
              variant={viewMode === 'kanban' ? 'default' : 'outline'}
              onClick={() => setViewMode('kanban')}
              className="rounded-[12px] gap-1.5"
            >
              <KanbanSquare className="h-3.5 w-3.5" /> Kanban
            </Button>
            <Button variant="outline" size="sm" className="rounded-[12px] gap-1.5" asChild>
              <a href="/api/admin/export?resource=orders">
                <Download className="h-3.5 w-3.5" /> Export CSV
              </a>
            </Button>
          </div>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonTable rows={6} cols={5} />}>
          {viewMode === 'kanban' ? (
            <div className="grid gap-4 md:grid-cols-4">
              {KANBAN_STATUSES.map((colStatus) => {
                const colOrders = orders.filter((o) => o.status === colStatus);
                return (
                  <Card key={colStatus} className="rounded-[20px] p-4 space-y-3 bg-muted/25">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-extrabold uppercase tracking-wider">{colStatus}</span>
                      <Badge variant="secondary">{colOrders.length}</Badge>
                    </div>
                    <div className="space-y-2">
                      {colOrders.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setSelectedOrder(o)}
                          className="w-full rounded-[14px] border border-border bg-card p-3 text-left text-xs hover:border-primary/40 transition"
                        >
                          <p className="font-mono font-bold text-primary">#{o.id.slice(0, 10)}</p>
                          <p className="font-bold truncate mt-0.5">{o.email}</p>
                          <p className="text-muted-foreground mt-0.5">{o.planName || 'Pro'} · {o.amountFormatted || '$0'}</p>
                        </button>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="rounded-[20px] overflow-hidden shadow-[var(--shadow-sm)]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-32 text-center text-xs text-muted-foreground">
                        No SaaS orders recorded in Firestore yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    orders.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-mono font-bold">#{o.id.slice(0, 10)}</TableCell>
                        <TableCell>{o.email || '—'}</TableCell>
                        <TableCell>{o.planName || 'Studio'}</TableCell>
                        <TableCell><Badge variant="secondary">{o.status}</Badge></TableCell>
                        <TableCell className="font-bold">{o.amountFormatted || '$0.00'}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setSelectedOrder(o)}>
                            Manage
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </Card>
          )}
        </MinReveal>

        <Sheet open={Boolean(selectedOrder)} onOpenChange={(o) => !o && setSelectedOrder(null)}>
          <SheetContent data-lenis-prevent>
            {selectedOrder && (
              <div className="space-y-4">
                <SheetHeader>
                  <SheetTitle>Order #{selectedOrder.id}</SheetTitle>
                </SheetHeader>
                <Input
                  placeholder="Audit reason (required, min 3 chars)…"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="rounded-[12px]"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void handleUpdateOrder(selectedOrder.id, 'fulfilled')}
                    className="rounded-[12px]"
                  >
                    Mark Fulfilled
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => void handleUpdateOrder(selectedOrder.id, 'refunded')}
                    className="rounded-[12px]"
                  >
                    Issue Refund
                  </Button>
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </PageTransition>
  );
}
