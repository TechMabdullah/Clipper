'use client';

import { SkeletonCard, SkeletonList } from '@/components/skeletons';

export function ClipsLoadingFallback() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonList items={3} />
    </div>
  );
}
