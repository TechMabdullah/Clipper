import { SkeletonList, SkeletonTabs } from '@/components/skeletons';

export default function QueueLoading() {
  return (
    <div className="space-y-6">
      <SkeletonTabs count={2} />
      <SkeletonList items={5} />
    </div>
  );
}
