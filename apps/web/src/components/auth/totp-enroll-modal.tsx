'use client';

import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { withLoader } from '@/stores/loader-store';

export function TotpVerifyModal({
  open,
  onOpenChange,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
}) {
  const [code, setCode] = React.useState('');

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) {
      toast.error('Enter your 6-digit authenticator code.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', code }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Invalid authenticator code.');
        return;
      }
      toast.success('Admin TOTP verified for this session.');
      setCode('');
      onVerified();
      onOpenChange(false);
    }, 'Verifying authenticator code…');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-[28px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-extrabold">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Admin TOTP 2FA Verification
          </DialogTitle>
          <DialogDescription>
            Enter the 6-digit code from your authenticator app before unlocking privileged admin
            controls.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col items-center gap-5 py-4">
          <InputOTP maxLength={6} value={code} onChange={setCode}>
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((idx) => (
                <InputOTPSlot key={idx} index={idx} className="h-12 w-11 rounded-[12px] text-base font-bold" />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <DialogFooter className="w-full sm:justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={code.length !== 6} className="rounded-[16px] font-bold">
              Verify & Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
