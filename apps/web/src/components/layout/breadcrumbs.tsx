'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';

const SEGMENT_LABELS: Record<string, string> = {
  overview: 'Overview',
  studio: 'Studio & Live',
  clips: 'Clips & Library',
  queue: 'Queue & Watchlist',
  orders: 'Orders & Invoices',
  billing: 'Billing & Plan',
  support: 'Support Center',
  notifications: 'Notifications',
  profile: 'Profile',
  settings: 'Settings',
  sessions: 'Active Sessions',
  admin: 'Admin Console',
  users: 'Users & Roles',
  content: 'Content & FAQ',
  flags: 'Feature Flags',
  audit: 'Audit Logs',
};

export function AppBreadcrumbs() {
  const pathname = usePathname() || '/overview';
  const parts = pathname.split('/').filter(Boolean);
  const homeHref = parts[0] === 'admin' ? '/admin/overview' : '/overview';

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <Link
        href={homeHref}
        className="flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-muted/70 hover:text-foreground transition"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
      {parts.map((part, idx) => {
        const href = '/' + parts.slice(0, idx + 1).join('/');
        const label = SEGMENT_LABELS[part] ?? part.charAt(0).toUpperCase() + part.slice(1);
        const isLast = idx === parts.length - 1;
        return (
          <span key={href} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 opacity-50" />
            {isLast ? (
              <span className="font-bold text-foreground">{label}</span>
            ) : (
              <Link href={href} className="hover:text-foreground transition">
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
