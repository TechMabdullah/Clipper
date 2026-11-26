'use client';

import * as React from 'react';
import { AnnouncementBanner } from './announcement-banner';
import { AppSidebar } from './sidebar';
import { AppHeader } from './header';
import { MobileBottomNav } from './mobile-nav';
import { AppFooter } from './footer';
import { AppCommandPalette } from './command-palette';
import { AmbientGlow } from '@/components/animated/ambient-glow';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import type { Role } from '@/lib/rbac';

const SIDEBAR_STORAGE_KEY = 'clipper_sidebar_collapsed_v1';

export function AppShell({
  surface,
  user,
  children,
}: {
  surface: 'customer' | 'admin';
  user: {
    uid: string;
    email: string;
    name: string;
    picture?: string;
    role: Role;
  };
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1');
    } catch {}
  }, []);

  const handleToggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  useKeyboardShortcuts({
    onOpenCommand: () => setCommandOpen(true),
  });

  return (
    <div
      data-surface={surface}
      className="min-h-screen flex flex-col bg-background text-foreground"
    >
      {surface === 'admin' && (
        <div
          aria-hidden="true"
          className="h-1 w-full bg-gradient-to-r from-[#6C63FF] via-[#FF5FA2] to-[#FF8A30]"
        />
      )}
      <AmbientGlow />
      <AnnouncementBanner />
      <div className="flex flex-1 min-h-0">
        <AppSidebar
          surface={surface}
          role={user.role}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
        />
        <div className="flex flex-1 flex-col min-w-0">
          <AppHeader
            surface={surface}
            user={user}
            onOpenCommand={() => setCommandOpen(true)}
          />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 max-w-[1600px] w-full mx-auto">
            {children}
          </main>
          <AppFooter surface={surface} />
        </div>
      </div>
      <MobileBottomNav surface={surface} />
      <AppCommandPalette open={commandOpen} onOpenChange={setCommandOpen} role={user.role} />
    </div>
  );
}
