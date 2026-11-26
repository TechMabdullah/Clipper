import { SkeletonAvatar, SkeletonForm } from '@/components/skeletons';

export default function ProfileLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <SkeletonAvatar size="lg" />
        <SkeletonForm fields={1} />
      </div>
      <SkeletonForm fields={4} />
    </div>
  );
}
