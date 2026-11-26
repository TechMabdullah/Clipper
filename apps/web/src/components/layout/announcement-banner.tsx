'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Megaphone, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PublicContextData {
  maintenance: { enabled: boolean; message: string };
  announcements: Array<{ id: string; title: string; body: string; tone?: 'info' | 'promo' | 'warning' }>;
}

export function AnnouncementBanner() {
  const [dismissedIds, setDismissedIds] = React.useState<string[]>([]);
  const { data } = useQuery<PublicContextData>({
    queryKey: ['public-context'],
    queryFn: async () => {
      const res = await fetch('/api/public/context', { cache: 'no-store' });
      if (!res.ok) return { maintenance: { enabled: false, message: '' }, announcements: [] };
      return res.json();
    },
    staleTime: 45_000,
  });

  const activeAnn = (data?.announcements ?? []).find((a) => !dismissedIds.includes(a.id));

  return (
    <div className="space-y-1">
      {data?.maintenance?.enabled && (
        <div className="flex items-center justify-center gap-2 bg-[#FFD43B] px-4 py-2 text-xs font-bold text-[#1A1A2E]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{data.maintenance.message || 'Scheduled maintenance mode is active.'}</span>
        </div>
      )}
      {activeAnn && (
        <div
          className={cn(
            'flex items-center justify-between gap-3 px-4 py-2 text-xs font-semibold',
            activeAnn.tone === 'warning'
              ? 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-b border-amber-500/25'
              : activeAnn.tone === 'promo'
                ? 'bg-gradient-to-r from-[#6C63FF] via-[#FF5FA2] to-[#FF8A30] text-white'
                : 'bg-primary/10 text-primary border-b border-primary/20',
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {activeAnn.tone === 'promo' ? (
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Megaphone className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="font-bold truncate">{activeAnn.title}:</span>
            <span className="truncate opacity-90">{activeAnn.body}</span>
          </div>
          <button
            type="button"
            onClick={() => setDismissedIds((prev) => [...prev, activeAnn.id])}
            className="rounded-full p-1 hover:bg-black/10 transition"
            aria-label="Dismiss announcement"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
