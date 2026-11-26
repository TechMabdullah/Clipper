'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  Activity,
  Bell,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Film,
  Flag,
  FileText,
  HelpCircle,
  KeyRound,
  LayoutDashboard,
  ListVideo,
  Receipt,
  Scissors,
  Settings,
  Shield,
  Sparkles,
  User,
  Users,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Role } from '@/lib/rbac';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

export const CUSTOMER_NAV_ITEMS: NavItem[] = [
  { href: '/overview', label: 'Overview', icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: '/studio', label: 'Studio & Live', icon: <Sparkles className="h-4 w-4" /> },
  { href: '/clips', label: 'Clips & Library', icon: <Film className="h-4 w-4" /> },
  { href: '/queue', label: 'Queue & Watchlist', icon: <ListVideo className="h-4 w-4" /> },
  { href: '/orders', label: 'Orders', icon: <Receipt className="h-4 w-4" /> },
  { href: '/billing', label: 'Billing & Plan', icon: <CreditCard className="h-4 w-4" /> },
  { href: '/support', label: 'Support', icon: <HelpCircle className="h-4 w-4" /> },
  { href: '/notifications', label: 'Notifications', icon: <Bell className="h-4 w-4" /> },
  { href: '/profile', label: 'Profile', icon: <User className="h-4 w-4" /> },
  { href: '/settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
  { href: '/sessions', label: 'Sessions', icon: <KeyRound className="h-4 w-4" /> },
];

export const ADMIN_NAV_ITEMS: NavItem[] = [
  { href: '/admin/overview', label: 'Admin Overview', icon: <Shield className="h-4 w-4" /> },
  { href: '/admin/users', label: 'Users & Roles', icon: <Users className="h-4 w-4" /> },
  { href: '/admin/orders', label: 'Orders & Refunds', icon: <Receipt className="h-4 w-4" /> },
  { href: '/admin/support', label: 'Support Inbox', icon: <HelpCircle className="h-4 w-4" /> },
  { href: '/admin/content', label: 'Content & FAQ', icon: <FileText className="h-4 w-4" /> },
  { href: '/admin/flags', label: 'Feature Flags', icon: <Flag className="h-4 w-4" /> },
  { href: '/admin/audit', label: 'Audit Logs', icon: <Activity className="h-4 w-4" /> },
  { href: '/admin/settings', label: 'System & RBAC', icon: <Settings className="h-4 w-4" /> },
];

export function AppSidebar({
  surface,
  role,
  collapsed,
  onToggleCollapse,
}: {
  surface: 'customer' | 'admin';
  role: Role;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const pathname = usePathname() || '/overview';
  const router = useRouter();
  const items = surface === 'admin' ? ADMIN_NAV_ITEMS : CUSTOMER_NAV_ITEMS;
  const isAdminCapable = role === 'support' || role === 'admin' || role === 'superadmin';

  return (
    <aside
      className={cn(
        'hidden md:flex flex-col shrink-0 border-r border-border bg-card/85 backdrop-blur-md transition-[width] duration-200 select-none',
        collapsed ? 'w-[76px]' : 'w-64',
      )}
    >
      <div className="flex h-16 items-center justify-between px-4 border-b border-border/70">
        <Link
          href={surface === 'admin' ? '/admin/overview' : '/overview'}
          className="flex items-center gap-2.5 min-w-0"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-gradient-to-br from-[#6C63FF] to-[#FF5FA2] text-white shadow-[var(--shadow-sm)]">
            <Scissors className="h-4 w-4" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <span className="block truncate text-sm font-extrabold tracking-tight text-foreground">
                Clipper Studio
              </span>
              <span className="block text-[10px] font-bold uppercase tracking-wider text-primary">
                {surface === 'admin' ? 'Admin Surface' : 'Creator SaaS'}
              </span>
            </div>
          )}
        </Link>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const linkEl = (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-sm font-semibold transition-colors',
                active
                  ? 'text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                collapsed && 'justify-center px-2',
              )}
            >
              {active && (
                <motion.span
                  layoutId={`sidebar-active-pill-${surface}`}
                  transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                  className="absolute inset-0 rounded-[14px] bg-primary shadow-[var(--shadow-sm)]"
                />
              )}
              <span className="relative z-10 shrink-0">{item.icon}</span>
              {!collapsed && <span className="relative z-10 truncate">{item.label}</span>}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger asChild>{linkEl}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          }
          return linkEl;
        })}
      </div>

      <div className="border-t border-border/70 p-3 space-y-2">
        {isAdminCapable && !collapsed && (
          <button
            type="button"
            onClick={() => router.push(surface === 'admin' ? '/overview' : '/admin/overview')}
            className="flex w-full items-center justify-between rounded-[14px] border border-border bg-muted/40 px-3 py-2 text-xs font-bold text-foreground hover:bg-muted transition"
          >
            <span>{surface === 'admin' ? 'Creator View' : 'Admin Console'}</span>
            <Badge variant="secondary" className="text-[10px]">
              {role}
            </Badge>
          </button>
        )}
        {!collapsed && surface === 'customer' && (
          <Link
            href="/billing"
            className="block rounded-[16px] bg-gradient-to-br from-[#6C63FF]/12 via-[#FF5FA2]/8 to-[#FF8A30]/10 p-3 border border-primary/15 hover:border-primary/40 transition"
          >
            <p className="text-xs font-extrabold text-foreground">Creator Studio Pro</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Manage license key, quotas & invoices →
            </p>
          </Link>
        )}
      </div>
    </aside>
  );
}
