import { SkeletonTable } from '@/components/skeletons';

export default function AdminAuditLoading() {
  return <SkeletonTable rows={8} cols={5} />;
}
