'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { confirmPasswordReset } from 'firebase/auth';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DoodleScene } from '@/components/doodle/doodle-scene';
import { DoodlePasswordField } from '@/components/auth/doodle-password-field';
import { getFirebaseClientAuth, isFirebaseClientConfigured, mapFirebaseAuthError } from '@/lib/firebase';
import { withLoader } from '@/stores/loader-store';
import { useDoodleStore } from '@/stores/doodle-store';

function ResetPasswordContent() {
  const router = useRouter();
  const params = useSearchParams();
  const oobCode = params?.get('oobCode') || '';
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errorText, setErrorText] = React.useState('');
  const { triggerWrongPassword, triggerSuccess } = useDoodleStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText('');
    if (!oobCode) {
      const msg = 'Missing reset token (oobCode). Open the link directly from your recovery email.';
      triggerWrongPassword();
      setErrorText(msg);
      return;
    }
    if (password.length < 8 || password !== confirm) {
      const msg = 'Passwords must be at least 8 characters and match.';
      triggerWrongPassword();
      setErrorText(msg);
      return;
    }
    if (!isFirebaseClientConfigured()) {
      setErrorText('Firebase configuration missing.');
      return;
    }

    await withLoader(async () => {
      try {
        await confirmPasswordReset(getFirebaseClientAuth(), oobCode, password);
        triggerSuccess();
        toast.success('Password updated! You can now sign in.');
        router.push('/login');
      } catch (err) {
        const msg = mapFirebaseAuthError(err);
        triggerWrongPassword();
        setErrorText(msg);
        toast.error(msg);
      }
    }, 'Updating your password…');
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12 items-stretch">
      <div className="lg:col-span-6">
        <DoodleScene customError={errorText} />
      </div>
      <div className="lg:col-span-6 flex flex-col justify-center p-4 sm:p-8 space-y-6">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Sign In
        </Link>

        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Choose new password</h1>
          <p className="text-sm text-muted-foreground">
            Create a strong password for your Clipper Studio account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-pw">New Password</Label>
            <DoodlePasswordField
              id="reset-pw"
              fieldKey="password"
              showStrength
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-confirm">Confirm New Password</Label>
            <DoodlePasswordField
              id="reset-confirm"
              fieldKey="confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {errorText && (
            <p className="rounded-[12px] bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
              {errorText}
            </p>
          )}
          <Button type="submit" className="h-11 w-full rounded-[16px] font-bold gap-2">
            <CheckCircle2 className="h-4 w-4" /> Save New Password
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-center text-sm">Loading reset form…</div>}>
      <ResetPasswordContent />
    </React.Suspense>
  );
}
