import { SkeletonForm, SkeletonTabs } from '@/components/skeletons';

export default function AdminSettingsLoading() {
  return (
    <div className="space-y-6">
      <SkeletonTabs count={3} />
      <SkeletonForm fields={5} />
    </div>
  );
}
