import { SkeletonCard, SkeletonForm, SkeletonTabs } from '@/components/skeletons';

export default function StudioLoading() {
  return (
    <div className="space-y-6">
      <SkeletonTabs count={3} />
      <div className="grid gap-6 lg:grid-cols-2">
        <SkeletonForm fields={5} />
        <SkeletonCard />
      </div>
    </div>
  );
}
