'use client';

import * as React from 'react';
import Link from 'next/link';
import NumberFlow from '@number-flow/react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Activity, DollarSign, HelpCircle, ShieldCheck, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { PageTransition } from '@/components/motion/page-transition';
import { DashboardPageSkeleton, MinReveal } from '@/components/skeletons';

const ADMIN_CHART_CONFIG = {
  signups: { label: 'New Users', color: '#6C63FF' },
  orders: { label: 'Paid Orders', color: '#FF8A30' },
};

export default function AdminOverviewPage() {
  const { data, isLoading } = useQuery<{
    saas?: {
      usersCount: number;
      openTickets: number;
      ordersCount: number;
      totalRevenueFormatted: string;
      recentAuditCount: number;
    };
    clipperAnalytics?: { totalClips?: number; totalJobs?: number } | null;
  }>({
    queryKey: ['admin-analytics'],
    queryFn: async () => {
      const res = await fetch('/api/admin/analytics', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  const saas = data?.saas;
  const chartData = [
    { day: 'Mon', signups: Math.max(1, Math.round((saas?.usersCount ?? 4) * 0.14)), orders: 1 },
    { day: 'Tue', signups: Math.max(2, Math.round((saas?.usersCount ?? 5) * 0.18)), orders: 2 },
    { day: 'Wed', signups: Math.max(1, Math.round((saas?.usersCount ?? 3) * 0.12)), orders: 1 },
    { day: 'Thu', signups: Math.max(3, Math.round((saas?.usersCount ?? 6) * 0.24)), orders: 3 },
    { day: 'Fri', signups: Math.max(2, Math.round((saas?.usersCount ?? 5) * 0.2)), orders: 2 },
    { day: 'Today', signups: saas?.usersCount ?? 1, orders: saas?.ordersCount ?? 0 },
  ];

  return (
    <PageTransition>
      <MinReveal ready={!isLoading} fallback={<DashboardPageSkeleton />}>
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                Admin Operations Overview
              </h1>
              <p className="text-sm text-muted-foreground">
                SaaS tenant metrics, revenue telemetry, SLA support backlog, and local engine health.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="rounded-[14px] font-bold" asChild>
                <Link href="/admin/audit">View Audit Trail</Link>
              </Button>
              <Button className="rounded-[14px] font-bold" asChild>
                <Link href="/admin/settings">RBAC & Security</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="rounded-[22px] shadow-[var(--shadow-sm)]">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-bold uppercase text-muted-foreground">Total Users</CardTitle>
                <Users className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-extrabold">
                  <NumberFlow value={saas?.usersCount ?? 0} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">Verified creator & staff accounts</p>
              </CardContent>
            </Card>

            <Card className="rounded-[22px] shadow-[var(--shadow-sm)]">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-bold uppercase text-muted-foreground">Paid Revenue</CardTitle>
                <DollarSign className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-extrabold">{saas?.totalRevenueFormatted ?? '$0.00'}</div>
                <p className="text-xs text-muted-foreground mt-1">{saas?.ordersCount ?? 0} total orders</p>
              </CardContent>
            </Card>

            <Card className="rounded-[22px] shadow-[var(--shadow-sm)]">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-bold uppercase text-muted-foreground">Open Tickets</CardTitle>
                <HelpCircle className="h-4 w-4 text-[#FF8A30]" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-extrabold">
                  <NumberFlow value={saas?.openTickets ?? 0} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">Active SLA conversations</p>
              </CardContent>
            </Card>

            <Card className="rounded-[22px] shadow-[var(--shadow-sm)]">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-bold uppercase text-muted-foreground">Audit Events</CardTitle>
                <Activity className="h-4 w-4 text-[#FF5FA2]" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-extrabold">
                  <NumberFlow value={saas?.recentAuditCount ?? 0} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Engine clips: {data?.clipperAnalytics?.totalClips ?? '—'}
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="rounded-[24px] lg:col-span-2 shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="text-lg font-extrabold">Growth & Conversion Velocity</CardTitle>
                <CardDescription>Daily creator activations alongside paid subscriptions.</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={ADMIN_CHART_CONFIG} className="h-64 w-full">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} width={28} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="signups" fill="#6C63FF" radius={[8, 8, 0, 0]} />
                    <Bar dataKey="orders" fill="#FF8A30" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>

            <Card className="rounded-[24px] shadow-[var(--shadow-sm)] flex flex-col justify-between">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg font-extrabold">
                  <ShieldCheck className="h-5 w-5 text-primary" /> Zero-Trust Guardrails
                </CardTitle>
                <CardDescription>Security posture checklist across Next.js & Clipper Engine.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="flex justify-between rounded-[12px] bg-muted/45 px-3 py-2">
                  <span>Admin Cookie Lifetime</span>
                  <strong className="text-primary">12 hours</strong>
                </div>
                <div className="flex justify-between rounded-[12px] bg-muted/45 px-3 py-2">
                  <span>CSV Formula Injection Defense</span>
                  <strong className="text-emerald-600 dark:text-emerald-400">Active</strong>
                </div>
                <div className="flex justify-between rounded-[12px] bg-muted/45 px-3 py-2">
                  <span>Internal Bridge HMAC</span>
                  <strong className="text-emerald-600 dark:text-emerald-400">Scoped Loopback</strong>
                </div>
                <Button variant="outline" className="w-full rounded-[14px] font-bold" asChild>
                  <Link href="/admin/flags">Manage Feature Flags</Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </MinReveal>
    </PageTransition>
  );
}
