import { SkeletonTable } from '@/components/skeletons';

export default function OrdersLoading() {
  return <SkeletonTable rows={6} cols={5} />;
}
