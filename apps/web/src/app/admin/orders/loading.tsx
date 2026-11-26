import { SkeletonTable } from '@/components/skeletons';

export default function AdminOrdersLoading() {
  return <SkeletonTable rows={7} cols={5} />;
}
