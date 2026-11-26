'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export function ShimmerBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative overflow-hidden rounded-[14px] bg-muted/75 before:absolute before:inset-0 before:bg-gradient-to-r before:from-transparent before:via-white/40 dark:before:via-white/10 before:to-transparent before:animate-[clipper-shimmer-sweep_1.6s_infinite]',
        className,
      )}
    />
  );
}

/**
 * Ensures skeleton placeholders stay visible at least minMs (default 250ms) to avoid 50ms layout flash.
 */
export function MinReveal({
  ready,
  fallback,
  children,
  minMs = 250,
}: {
  ready: boolean;
  fallback: React.ReactNode;
  children: React.ReactNode;
  minMs?: number;
}) {
  const [elapsedOk, setElapsedOk] = React.useState(false);

  React.useEffect(() => {
    const t = window.setTimeout(() => setElapsedOk(true), minMs);
    return () => window.clearTimeout(t);
  }, [minMs]);

  if (!ready || !elapsedOk) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}

/** 1. SkeletonCard */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[24px] border border-border bg-card p-6 shadow-[var(--shadow-sm)] space-y-4',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <ShimmerBlock className="h-5 w-40" />
        <ShimmerBlock className="h-7 w-16 rounded-full" />
      </div>
      <ShimmerBlock className="h-4 w-full" />
      <ShimmerBlock className="h-4 w-3/4" />
      <ShimmerBlock className="h-28 w-full rounded-[16px]" />
    </div>
  );
}

/** 2. SkeletonStat */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[24px] border border-border bg-card p-5 shadow-[var(--shadow-sm)] space-y-3',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <ShimmerBlock className="h-3.5 w-24" />
        <ShimmerBlock className="h-8 w-8 rounded-[12px]" />
      </div>
      <ShimmerBlock className="h-8 w-28" />
      <ShimmerBlock className="h-3 w-20" />
    </div>
  );
}

/** 3. SkeletonTable */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-[24px] border border-border bg-card overflow-hidden shadow-[var(--shadow-sm)]">
      <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-5 py-3.5">
        {Array.from({ length: cols }).map((_, idx) => (
          <ShimmerBlock key={idx} className="h-3.5 flex-1" />
        ))}
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, rIdx) => (
          <div key={rIdx} className="flex items-center gap-4 px-5 py-4">
            {Array.from({ length: cols }).map((_, cIdx) => (
              <ShimmerBlock
                key={cIdx}
                className={cn('h-4 flex-1', cIdx === 0 && 'max-w-[180px]')}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 4. SkeletonChart */
export function SkeletonChart({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-[24px] border border-border bg-card p-6 shadow-[var(--shadow-sm)] space-y-4',
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <ShimmerBlock className="h-5 w-44" />
          <ShimmerBlock className="h-3 w-64" />
        </div>
        <ShimmerBlock className="h-9 w-28 rounded-[14px]" />
      </div>
      <div className="flex h-56 items-end gap-3 pt-4">
        {[48, 72, 60, 88, 65, 92, 54, 78, 84, 62, 95, 70].map((h, i) => (
          <div key={i} className="flex-1 h-full flex items-end">
            <ShimmerBlock className="w-full rounded-t-[10px]" />
            <span className="sr-only">{h}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 5. SkeletonList */
export function SkeletonList({ items = 4 }: { items?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: items }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-4 rounded-[20px] border border-border bg-card p-4"
        >
          <div className="flex items-center gap-3 flex-1">
            <ShimmerBlock className="h-11 w-11 shrink-0 rounded-[14px]" />
            <div className="space-y-2 flex-1">
              <ShimmerBlock className="h-4 w-48" />
              <ShimmerBlock className="h-3 w-72 max-w-full" />
            </div>
          </div>
          <ShimmerBlock className="h-8 w-20 rounded-[14px]" />
        </div>
      ))}
    </div>
  );
}

/** 6. SkeletonAvatar */
export function SkeletonAvatar({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-16 w-16' : 'h-10 w-10';
  return <ShimmerBlock className={cn('rounded-full shrink-0', dim)} />;
}

/** 7. SkeletonForm */
export function SkeletonForm({ fields = 4 }: { fields?: number }) {
  return (
    <div className="rounded-[24px] border border-border bg-card p-6 space-y-5 shadow-[var(--shadow-sm)]">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-2">
          <ShimmerBlock className="h-3.5 w-28" />
          <ShimmerBlock className="h-11 w-full rounded-[16px]" />
        </div>
      ))}
      <div className="flex justify-end pt-2">
        <ShimmerBlock className="h-11 w-36 rounded-[16px]" />
      </div>
    </div>
  );
}

/** 8. SkeletonSidebar */
export function SkeletonSidebar() {
  return (
    <div className="w-64 shrink-0 space-y-4 p-4 border-r border-border bg-card/70">
      <div className="flex items-center gap-3 px-2 py-1">
        <ShimmerBlock className="h-9 w-9 rounded-[12px]" />
        <ShimmerBlock className="h-5 w-28" />
      </div>
      <div className="space-y-2 pt-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <ShimmerBlock key={i} className="h-10 w-full rounded-[14px]" />
        ))}
      </div>
    </div>
  );
}

/** 9. SkeletonHeader */
export function SkeletonHeader() {
  return (
    <div className="flex h-16 items-center justify-between border-b border-border bg-card/85 px-6">
      <div className="flex items-center gap-3">
        <ShimmerBlock className="h-8 w-8 rounded-[12px]" />
        <ShimmerBlock className="h-4 w-44" />
      </div>
      <div className="flex items-center gap-3">
        <ShimmerBlock className="h-9 w-56 rounded-[16px] hidden md:block" />
        <ShimmerBlock className="h-9 w-9 rounded-full" />
        <SkeletonAvatar size="sm" />
      </div>
    </div>
  );
}

/** 10. SkeletonTabs */
export function SkeletonTabs({ count = 4 }: { count?: number }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-[16px] border border-border bg-card p-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <ShimmerBlock key={i} className="h-8 w-24 rounded-[12px]" />
      ))}
    </div>
  );
}

/** 11. SkeletonDrawer */
export function SkeletonDrawer() {
  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center gap-3">
        <SkeletonAvatar size="lg" />
        <div className="space-y-2 flex-1">
          <ShimmerBlock className="h-5 w-44" />
          <ShimmerBlock className="h-3.5 w-32" />
        </div>
      </div>
      <ShimmerBlock className="h-24 w-full rounded-[18px]" />
      <SkeletonList items={3} />
    </div>
  );
}

export function DashboardPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <ShimmerBlock className="h-8 w-56" />
          <ShimmerBlock className="h-4 w-80" />
        </div>
        <ShimmerBlock className="h-10 w-36 rounded-[16px]" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
        <SkeletonStat />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <SkeletonChart className="lg:col-span-2" />
        <SkeletonCard />
      </div>
      <SkeletonTable rows={5} cols={5} />
    </div>
  );
}
