'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  Activity,
  Bell,
  CreditCard,
  Film,
  Flag,
  HelpCircle,
  KeyRound,
  LayoutDashboard,
  ListVideo,
  Moon,
  Receipt,
  Settings,
  Shield,
  Sparkles,
  Sun,
  User,
  Users,
  FileText,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import type { Role } from '@/lib/rbac';

interface CommandItemDef {
  label: string;
  href?: string;
  keywords?: string;
  group: 'Creator' | 'Account' | 'Admin' | 'Actions';
  icon: React.ReactNode;
  minAdmin?: boolean;
  onRun?: () => void;
}

export function AppCommandPalette({
  open,
  onOpenChange,
  role,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  role: Role;
}) {
  const router = useRouter();
  const { setTheme, theme } = useTheme();
  const isAdmin = role === 'support' || role === 'admin' || role === 'superadmin';

  const items: CommandItemDef[] = [
    { label: 'Overview Dashboard', href: '/overview', group: 'Creator', icon: <LayoutDashboard className="h-4 w-4" /> },
    { label: 'Studio & Live Clipper', href: '/studio', keywords: 'vod montage ffmpeg facecam', group: 'Creator', icon: <Sparkles className="h-4 w-4" /> },
    { label: 'Clips & Collections Library', href: '/clips', keywords: 'ratings share ab chapter', group: 'Creator', icon: <Film className="h-4 w-4" /> },
    { label: 'Upload Queue & Watchlist', href: '/queue', keywords: 'tiktok youtube shorts auto-clip', group: 'Creator', icon: <ListVideo className="h-4 w-4" /> },
    { label: 'Orders & Invoices', href: '/orders', group: 'Account', icon: <Receipt className="h-4 w-4" /> },
    { label: 'Billing & Stripe Plan', href: '/billing', group: 'Account', icon: <CreditCard className="h-4 w-4" /> },
    { label: 'Support & Tickets', href: '/support', group: 'Account', icon: <HelpCircle className="h-4 w-4" /> },
    { label: 'Notifications', href: '/notifications', group: 'Account', icon: <Bell className="h-4 w-4" /> },
    { label: 'Profile & Linked Accounts', href: '/profile', group: 'Account', icon: <User className="h-4 w-4" /> },
    { label: 'Workspace Settings', href: '/settings', group: 'Account', icon: <Settings className="h-4 w-4" /> },
    { label: 'Active Sessions & Security', href: '/sessions', group: 'Account', icon: <KeyRound className="h-4 w-4" /> },
    ...(isAdmin
      ? [
          { label: 'Admin Overview', href: '/admin/overview', group: 'Admin' as const, icon: <Shield className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin Users & Roles', href: '/admin/users', group: 'Admin' as const, icon: <Users className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin Orders & Refunds', href: '/admin/orders', group: 'Admin' as const, icon: <Receipt className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin Support Inbox', href: '/admin/support', group: 'Admin' as const, icon: <HelpCircle className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin Content & FAQ', href: '/admin/content', group: 'Admin' as const, icon: <FileText className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin Feature Flags', href: '/admin/flags', group: 'Admin' as const, icon: <Flag className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin Audit Logs', href: '/admin/audit', group: 'Admin' as const, icon: <Activity className="h-4 w-4" />, minAdmin: true },
          { label: 'Admin System & RBAC Settings', href: '/admin/settings', group: 'Admin' as const, icon: <Settings className="h-4 w-4" />, minAdmin: true },
        ]
      : []),
    {
      label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`,
      group: 'Actions',
      icon: theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
      onRun: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
  ];

  const groups: Array<'Creator' | 'Account' | 'Admin' | 'Actions'> = ['Creator', 'Account', 'Admin', 'Actions'];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search Clipper Studio pages, tools, or admin controls…" />
      <CommandList>
        <CommandEmpty>No matching pages or actions found.</CommandEmpty>
        {groups.map((groupName, gIdx) => {
          const groupItems = items.filter((i) => i.group === groupName);
          if (groupItems.length === 0) return null;
          return (
            <React.Fragment key={groupName}>
              {gIdx > 0 && <CommandSeparator />}
              <CommandGroup heading={groupName}>
                {groupItems.map((item) => (
                  <CommandItem
                    key={item.label}
                    value={`${item.label} ${item.keywords ?? ''}`}
                    onSelect={() => {
                      onOpenChange(false);
                      if (item.href) {
                        router.push(item.href);
                      } else {
                        item.onRun?.();
                      }
                    }}
                  >
                    <span className="mr-2 text-primary">{item.icon}</span>
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </React.Fragment>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
