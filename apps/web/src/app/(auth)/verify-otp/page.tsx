'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import confetti from 'canvas-confetti';
import { ArrowLeft, MailCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { DoodleScene } from '@/components/doodle/doodle-scene';
import { OTP_PENDING_STORAGE_KEY } from '@/components/auth/auth-social-buttons';
import { getFirebaseClientAuth, isFirebaseClientConfigured } from '@/lib/firebase';
import { withLoader } from '@/stores/loader-store';
import { useDoodleStore } from '@/stores/doodle-store';
import { cn } from '@/lib/utils';

interface PendingOtpInfo {
  email: string;
  purpose: 'login' | 'signup' | 'sensitive_action';
  next?: string;
  expiresAt?: number;
  delivery?: 'resend' | 'dev_echo';
  devCode?: string;
  name?: string;
}

export default function VerifyOtpPage() {
  const router = useRouter();
  const [pending, setPending] = React.useState<PendingOtpInfo | null>(null);
  const [code, setCode] = React.useState('');
  const [totpStep, setTotpStep] = React.useState(false);
  const [totpCode, setTotpCode] = React.useState('');
  const [redirectTarget, setRedirectTarget] = React.useState('/overview');
  const [errorText, setErrorText] = React.useState('');
  const [cooldownSec, setCooldownSec] = React.useState(60);
  const [expirySec, setExpirySec] = React.useState(300);

  const { triggerWrongPassword, triggerSuccess, shakeKey, setFocusedField } = useDoodleStore();

  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(OTP_PENDING_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingOtpInfo;
        setPending(parsed);
        if (parsed.expiresAt) {
          setExpirySec(Math.max(0, Math.floor((parsed.expiresAt - Date.now()) / 1000)));
        }
      }
    } catch {}
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setCooldownSec((c) => Math.max(0, c - 1));
      setExpirySec((e) => Math.max(0, e - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const submitOtp = React.useCallback(
    async (submittedCode: string) => {
      if (submittedCode.length !== 6) return;
      if (!isFirebaseClientConfigured()) {
        toast.error('Firebase configuration missing.');
        return;
      }

      setErrorText('');
      await withLoader(async () => {
        try {
          const user = getFirebaseClientAuth().currentUser;
          if (!user) {
            throw new Error('Your login session expired before OTP check. Please sign in again.');
          }
          const idToken = await user.getIdToken(true);
          const res = await fetch('/api/auth/otp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              idToken,
              code: submittedCode,
              purpose: pending?.purpose ?? 'login',
              name: pending?.name,
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Verification failed.');
          }

          window.sessionStorage.removeItem(OTP_PENDING_STORAGE_KEY);
          triggerSuccess();
          try {
            confetti({ particleCount: 70, spread: 60, origin: { y: 0.65 } });
          } catch {}

          const dest = data.redirectTo || pending?.next || '/overview';
          setRedirectTarget(dest);

          if (data.totpRequired) {
            toast.info('Admin 2FA enabled — enter your authenticator TOTP code.');
            setTotpStep(true);
            return;
          }

          toast.success('Verified! Launching your studio…');
          router.push(dest);
          router.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Invalid verification code.';
          triggerWrongPassword();
          setErrorText(msg);
          toast.error(msg);
        }
      }, 'Verifying 6-digit code…');
    },
    [pending, router, triggerSuccess, triggerWrongPassword],
  );

  const handleResend = async () => {
    if (cooldownSec > 0) return;
    await withLoader(async () => {
      try {
        const user = getFirebaseClientAuth().currentUser;
        if (!user) {
          throw new Error('Please return to Sign In to start a new verification challenge.');
        }
        const idToken = await user.getIdToken(true);
        const res = await fetch('/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, purpose: pending?.purpose ?? 'login' }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.retryAfterSec) setCooldownSec(Number(data.retryAfterSec));
          throw new Error(data.error || 'Unable to resend code.');
        }
        setCooldownSec(60);
        setExpirySec(300);
        setErrorText('');
        setCode('');
        setPending((prev) => ({
          ...(prev ?? { email: data.email, purpose: 'login' }),
          expiresAt: data.expiresAt,
          delivery: data.delivery,
          devCode: data.devCode,
        }));
        toast.success(`Fresh 6-digit code emailed to ${data.email}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not resend OTP.';
        triggerWrongPassword();
        setErrorText(msg);
        toast.error(msg);
      }
    }, 'Sending fresh verification code…');
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (totpCode.length !== 6) return;
    await withLoader(async () => {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        triggerWrongPassword();
        setErrorText(data.error || 'Invalid authenticator code.');
        toast.error(data.error || 'Invalid authenticator code.');
        return;
      }
      triggerSuccess();
      toast.success('Admin TOTP confirmed!');
      router.push(redirectTarget);
      router.refresh();
    }, 'Confirming admin authenticator…');
  };

  const fmtSec = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  return (
    <div className="grid gap-6 lg:grid-cols-12 items-stretch">
      <div className="lg:col-span-6">
        <DoodleScene customError={errorText} />
      </div>
      <div
        key={shakeKey}
        className={cn(
          'lg:col-span-6 flex flex-col justify-center p-4 sm:p-8 space-y-6',
          errorText && 'animate-auth-shake',
        )}
      >
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Sign In
        </Link>

        {totpStep ? (
          <form onSubmit={handleTotpSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Badge className="rounded-full bg-primary/15 text-primary hover:bg-primary/15">
                <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Admin 2FA Step
              </Badge>
              <h1 className="text-2xl font-extrabold tracking-tight">Enter Authenticator TOTP</h1>
              <p className="text-sm text-muted-foreground">
                Your admin account enforces a hardware/app TOTP code before unlocking `/admin`.
              </p>
            </div>
            <InputOTP maxLength={6} value={totpCode} onChange={setTotpCode}>
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((idx) => (
                  <InputOTPSlot key={idx} index={idx} className="h-12 w-11 rounded-[14px] text-lg font-extrabold" />
                ))}
              </InputOTPGroup>
            </InputOTP>
            <Button type="submit" disabled={totpCode.length !== 6} className="h-11 w-full rounded-[16px] font-bold">
              Unlock Admin Console
            </Button>
          </form>
        ) : (
          <div className="space-y-6">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/12 px-3 py-1 text-xs font-bold text-primary">
                <MailCheck className="h-3.5 w-3.5" /> Post-Login Email Verification
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                Check your inbox
              </h1>
              <p className="text-sm text-muted-foreground">
                We emailed a 6-digit verification code to{' '}
                <span className="font-bold text-foreground">{pending?.email || 'your email'}</span>.
              </p>
            </div>

            {pending?.devCode && (
              <div className="rounded-[16px] border border-[#FFD43B] bg-[#FFD43B]/15 px-4 py-3 text-xs font-bold text-foreground">
                Local DEV_OTP_ECHO active — test verification code:{' '}
                <span className="font-mono text-sm tracking-widest text-primary">{pending.devCode}</span>
              </div>
            )}

            <div className="space-y-4">
              <div
                onFocus={() => setFocusedField('password')}
                onBlur={() => setFocusedField('none')}
                className="flex justify-center sm:justify-start"
              >
                <InputOTP
                  maxLength={6}
                  value={code}
                  onChange={(v) => {
                    setCode(v);
                    if (v.length === 6) {
                      void submitOtp(v);
                    }
                  }}
                >
                  <InputOTPGroup className="gap-2">
                    {[0, 1, 2, 3, 4, 5].map((idx) => (
                      <InputOTPSlot
                        key={idx}
                        index={idx}
                        className="h-13 w-11 sm:w-12 rounded-[16px] border text-lg font-extrabold"
                      />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground font-medium">
                <span>
                  Expires in{' '}
                  <strong className={cn(expirySec < 60 && 'text-destructive')}>
                    {fmtSec(expirySec)}
                  </strong>
                </span>
                <span>Max 5 attempts per code</span>
              </div>

              {errorText && (
                <p
                  aria-live="assertive"
                  className="rounded-[12px] bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
                >
                  {errorText}
                </p>
              )}

              <Button
                type="button"
                disabled={code.length !== 6}
                onClick={() => void submitOtp(code)}
                className="h-11 w-full rounded-[16px] font-bold text-sm"
              >
                Verify Code & Enter Studio
              </Button>

              <Button
                type="button"
                variant="outline"
                disabled={cooldownSec > 0}
                onClick={handleResend}
                className="h-10 w-full rounded-[16px] text-xs font-bold gap-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {cooldownSec > 0 ? `Resend code in ${cooldownSec}s` : 'Resend verification code'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
