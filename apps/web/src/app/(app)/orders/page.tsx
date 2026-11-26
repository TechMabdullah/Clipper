'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useQueryState } from 'nuqs';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { FileDown, Receipt, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonTable } from '@/components/skeletons';

interface CustomerOrder {
  id: string;
  planName?: string;
  planId?: string;
  amountFormatted?: string;
  amountCents?: number;
  status: string;
  createdAtIso?: string;
  createdAt?: number;
}

export default function CustomerOrdersPage() {
  const [search, setSearch] = useQueryState('q', { defaultValue: '' });
  const [statusFilter, setStatusFilter] = useQueryState('status', { defaultValue: 'all' });
  const [selectedOrder, setSelectedOrder] = React.useState<CustomerOrder | null>(null);

  const { data, isLoading } = useQuery<{ orders: CustomerOrder[] }>({
    queryKey: ['customer-orders'],
    queryFn: async () => {
      const res = await fetch('/api/customer/orders', { cache: 'no-store' });
      return res.ok ? res.json() : { orders: [] };
    },
  });

  const filtered = React.useMemo(() => {
    return (data?.orders ?? []).filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (search.trim()) {
        const hay = `${o.id} ${o.planName ?? ''} ${o.status}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [data?.orders, search, statusFilter]);

  const columns: ColumnDef<CustomerOrder>[] = [
    {
      accessorKey: 'id',
      header: 'Order #',
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => setSelectedOrder(row.original)}
          className="font-mono text-xs font-bold text-primary hover:underline"
        >
          #{row.original.id.slice(0, 12)}
        </button>
      ),
    },
    {
      accessorKey: 'planName',
      header: 'Plan / Item',
      cell: ({ row }) => <span className="font-semibold">{row.original.planName || row.original.planId || 'Studio Pro'}</span>,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={row.original.status === 'paid' ? 'default' : 'secondary'}>{row.original.status}</Badge>,
    },
    {
      accessorKey: 'amountFormatted',
      header: 'Amount',
      cell: ({ row }) => (
        <span className="font-bold">
          {row.original.amountFormatted ||
            (typeof row.original.amountCents === 'number'
              ? `$${(row.original.amountCents / 100).toFixed(2)}`
              : '$0.00')}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Invoice',
      cell: ({ row }) => (
        <Button variant="outline" size="sm" className="h-8 rounded-[12px] text-xs gap-1.5" asChild>
          <a href={`/api/customer/invoices?orderId=${encodeURIComponent(row.original.id)}`}>
            <FileDown className="h-3.5 w-3.5" /> PDF
          </a>
        </Button>
      ),
    },
  ];

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Orders & Invoices</h1>
            <p className="text-sm text-muted-foreground">
              Inspect past transactions, download official PDF receipts, or renew your plan.
            </p>
          </div>
          <Button className="rounded-[16px] font-bold gap-2" asChild>
            <Link href="/billing">
              <RefreshCw className="h-4 w-4" /> Manage Plan & Reorder
            </Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search order # or plan…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 rounded-[16px] pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 rounded-[16px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="fulfilled">Fulfilled</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonTable rows={6} cols={5} />}>
          <Card className="rounded-[24px] overflow-hidden shadow-[var(--shadow-sm)]">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((h) => (
                      <TableHead key={h.id}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-36 text-center text-sm text-muted-foreground">
                      <Receipt className="mx-auto mb-2 h-6 w-6 opacity-40" />
                      No subscription orders recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </MinReveal>

        <Sheet open={Boolean(selectedOrder)} onOpenChange={(o) => !o && setSelectedOrder(null)}>
          <SheetContent data-lenis-prevent>
            {selectedOrder && (
              <div className="space-y-5">
                <SheetHeader>
                  <SheetTitle>Invoice #{selectedOrder.id}</SheetTitle>
                  <SheetDescription>Transaction breakdown and PDF receipt download.</SheetDescription>
                </SheetHeader>
                <div className="space-y-3 rounded-[18px] border border-border p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Plan</span>
                    <span className="font-bold">{selectedOrder.planName || 'Clipper Studio'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <Badge>{selectedOrder.status}</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Date</span>
                    <span>{selectedOrder.createdAtIso?.slice(0, 10) || '—'}</span>
                  </div>
                </div>
                <Button className="w-full rounded-[16px] font-bold gap-2" asChild>
                  <a href={`/api/customer/invoices?orderId=${encodeURIComponent(selectedOrder.id)}`}>
                    <FileDown className="h-4 w-4" /> Download Official PDF Invoice
                  </a>
                </Button>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </PageTransition>
  );
}
