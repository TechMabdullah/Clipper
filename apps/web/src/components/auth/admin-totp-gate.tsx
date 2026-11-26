'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { TotpVerifyModal } from './totp-enroll-modal';

export function AdminTotpGate({ needsTotp }: { needsTotp: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(needsTotp);

  React.useEffect(() => {
    setOpen(needsTotp);
  }, [needsTotp]);

  if (!needsTotp) return null;

  return (
    <TotpVerifyModal
      open={open}
      onOpenChange={(next) => {
        if (!next) router.push('/overview');
        setOpen(next);
      }}
      onVerified={() => {
        setOpen(false);
        router.refresh();
      }}
    />
  );
}
