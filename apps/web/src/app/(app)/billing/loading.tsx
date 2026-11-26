import { SkeletonCard } from '@/components/skeletons';

export default function BillingLoading() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
