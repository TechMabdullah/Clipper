import { SkeletonForm, SkeletonList } from '@/components/skeletons';

export default function AdminContentLoading() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SkeletonForm fields={4} />
      <SkeletonList items={4} />
    </div>
  );
}
