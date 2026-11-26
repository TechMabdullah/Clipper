'use client';

import * as React from 'react';
import Link from 'next/link';
import { sendPasswordResetEmail } from 'firebase/auth';
import { ArrowLeft, Mail, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DoodleScene } from '@/components/doodle/doodle-scene';
import { getFirebaseClientAuth, isFirebaseClientConfigured, mapFirebaseAuthError } from '@/lib/firebase';
import { withLoader } from '@/stores/loader-store';
import { useDoodleStore } from '@/stores/doodle-store';

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');
  const { setFocusedField, triggerWrongPassword, triggerSuccess } = useDoodleStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setErrorText('');

    if (!isFirebaseClientConfigured()) {
      const msg = 'Firebase configuration missing in .env.local.';
      triggerWrongPassword();
      setErrorText(msg);
      toast.error(msg);
      return;
    }

    await withLoader(async () => {
      try {
        await sendPasswordResetEmail(getFirebaseClientAuth(), email.trim(), {
          url: `${window.location.origin}/reset-password`,
        });
        setSent(true);
        triggerSuccess();
        toast.success(`Reset instructions sent to ${email}`);
      } catch (err) {
        const msg = mapFirebaseAuthError(err);
        triggerWrongPassword();
        setErrorText(msg);
        toast.error(msg);
      }
    }, 'Sending password reset link…');
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
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Reset your password</h1>
          <p className="text-sm text-muted-foreground">
            Enter your account email and we will send a secure Firebase password recovery link.
          </p>
        </div>

        {sent ? (
          <div className="rounded-[20px] border border-emerald-500/30 bg-emerald-500/10 p-5 space-y-2">
            <p className="text-sm font-extrabold text-emerald-700 dark:text-emerald-300">
              Recovery email dispatched!
            </p>
            <p className="text-xs text-muted-foreground">
              Check <strong>{email}</strong> (including spam/promotions) and follow the link to pick
              a new password.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="forgot-email">Account Email</Label>
              <div className="relative flex items-center">
                <Mail className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="forgot-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField('none')}
                  placeholder="you@studio.com"
                  className="h-11 rounded-[16px] pl-10"
                />
              </div>
            </div>
            {errorText && (
              <p className="rounded-[12px] bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
                {errorText}
              </p>
            )}
            <Button type="submit" className="h-11 w-full rounded-[16px] font-bold gap-2">
              <Send className="h-4 w-4" /> Send Reset Link
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
