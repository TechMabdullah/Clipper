'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useQuery } from '@tanstack/react-query';
import {
  LogOut,
  Menu,
  Moon,
  Search,
  Shield,
  Sparkles,
  Sun,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { AppBreadcrumbs } from './breadcrumbs';
import { NotificationsBell } from './notifications-bell';
import { ADMIN_NAV_ITEMS, CUSTOMER_NAV_ITEMS } from './sidebar';
import { withLoader } from '@/stores/loader-store';
import { signOutClient } from '@/lib/firebase';
import type { Role } from '@/lib/rbac';
import { cn } from '@/lib/utils';

export function AppHeader({
  surface,
  user,
  onOpenCommand,
}: {
  surface: 'customer' | 'admin';
  user: {
    uid: string;
    email: string;
    name: string;
    picture?: string;
    role: Role;
  };
  onOpenCommand: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() || '/overview';
  const { setTheme, theme } = useTheme();
  const isAdminCapable = user.role === 'support' || user.role === 'admin' || user.role === 'superadmin';
  const navItems = surface === 'admin' ? ADMIN_NAV_ITEMS : CUSTOMER_NAV_ITEMS;

  const { data: health } = useQuery<{ clipperBridge?: { reachable: boolean } }>({
    queryKey: ['web-health'],
    queryFn: async () => {
      const res = await fetch('/api/health', { cache: 'no-store' });
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const engineOnline = Boolean(health?.clipperBridge?.reachable);

  const handleLogout = async () => {
    await withLoader(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      await signOutClient();
      toast.success('Signed out safely.');
      router.push('/login');
      router.refresh();
    }, 'Signing you out…');
  };

  const initials = (user.name || user.email || 'CS')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card/85 px-4 sm:px-6 backdrop-blur-md">
      <div className="flex items-center gap-3 min-w-0">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden rounded-[12px]" aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="border-b border-border px-5 py-4 text-left">
              <SheetTitle className="flex items-center gap-2 text-base font-extrabold">
                <Sparkles className="h-4 w-4 text-primary" />
                Clipper Studio
              </SheetTitle>
            </SheetHeader>
            <div className="p-3 space-y-1">
              {navItems.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 rounded-[14px] px-3 py-2.5 text-sm font-semibold transition',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              {isAdminCapable && (
                <Link
                  href={surface === 'admin' ? '/overview' : '/admin/overview'}
                  className="mt-4 flex items-center gap-2 rounded-[14px] border border-border px-3 py-2.5 text-xs font-bold text-primary"
                >
                  <Shield className="h-4 w-4" />
                  {surface === 'admin' ? 'Switch to Creator App' : 'Switch to Admin Console'}
                </Link>
              )}
            </div>
          </SheetContent>
        </Sheet>

        <AppBreadcrumbs />
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenCommand}
          className="hidden lg:flex items-center gap-2.5 rounded-[16px] border border-border bg-muted/45 px-3.5 py-2 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground transition w-60 justify-between"
        >
          <span className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5" />
            Search workspace…
          </span>
          <kbd className="rounded bg-card px-1.5 py-0.5 text-[10px] font-bold border border-border">
            Ctrl K
          </kbd>
        </button>

        <Link
          href={surface === 'admin' ? '/admin/settings' : '/studio'}
          className={cn(
            'hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition',
            engineOnline
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              engineOnline ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500',
            )}
          />
          {engineOnline ? 'Engine Ready' : 'Engine Offline'}
        </Link>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-[14px]"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>

        <NotificationsBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex items-center gap-2 rounded-[16px] pl-1.5 pr-2.5 h-10"
            >
              <Avatar className="h-7 w-7 border border-primary/25">
                <AvatarImage src={user.picture || undefined} alt={user.name} />
                <AvatarFallback className="bg-primary/15 text-xs font-extrabold text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden md:inline max-w-[110px] truncate text-xs font-bold">
                {user.name}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 rounded-[20px] p-2 shadow-[var(--shadow-2)]">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-extrabold leading-none truncate">{user.name}</p>
                  <Badge variant="secondary" className="text-[10px] uppercase">
                    {user.role}
                  </Badge>
                </div>
                <p className="text-xs leading-none text-muted-foreground truncate">{user.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/profile" className="cursor-pointer">
                <User className="mr-2 h-4 w-4" /> Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/billing" className="cursor-pointer">
                Billing & Plan
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/sessions" className="cursor-pointer">
                Active Sessions
              </Link>
            </DropdownMenuItem>
            {isAdminCapable && (
              <DropdownMenuItem asChild>
                <Link
                  href={surface === 'admin' ? '/overview' : '/admin/overview'}
                  className="cursor-pointer font-semibold text-primary"
                >
                  <Shield className="mr-2 h-4 w-4" />
                  {surface === 'admin' ? 'Creator Dashboard' : 'Admin Console'}
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer text-destructive focus:text-destructive font-semibold"
            >
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
