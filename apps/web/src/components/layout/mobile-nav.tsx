'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Film, LayoutDashboard, ListVideo, Shield, Sparkles, User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export function MobileBottomNav({ surface }: { surface: 'customer' | 'admin' }) {
  const pathname = usePathname() || '/overview';

  const items =
    surface === 'admin'
      ? [
          { href: '/admin/overview', label: 'Overview', icon: <Shield className="h-4 w-4" /> },
          { href: '/admin/users', label: 'Users', icon: <Users className="h-4 w-4" /> },
          { href: '/admin/orders', label: 'Orders', icon: <LayoutDashboard className="h-4 w-4" /> },
          { href: '/admin/support', label: 'Inbox', icon: <ListVideo className="h-4 w-4" /> },
          { href: '/overview', label: 'App', icon: <User className="h-4 w-4" /> },
        ]
      : [
          { href: '/overview', label: 'Home', icon: <LayoutDashboard className="h-4 w-4" /> },
          { href: '/studio', label: 'Studio', icon: <Sparkles className="h-4 w-4" /> },
          { href: '/clips', label: 'Clips', icon: <Film className="h-4 w-4" /> },
          { href: '/queue', label: 'Queue', icon: <ListVideo className="h-4 w-4" /> },
          { href: '/profile', label: 'Profile', icon: <User className="h-4 w-4" /> },
        ];

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center justify-around border-t border-border bg-card/95 backdrop-blur-md md:hidden px-2">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex flex-col items-center justify-center gap-1 rounded-[12px] px-3 py-1.5 text-[11px] font-semibold transition',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
