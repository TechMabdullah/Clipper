import { SkeletonTable } from '@/components/skeletons';

export default function AdminUsersLoading() {
  return <SkeletonTable rows={8} cols={6} />;
}
