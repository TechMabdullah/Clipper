'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { ArrowRight, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { DoodleScene } from '@/components/doodle/doodle-scene';
import { DoodlePasswordField } from '@/components/auth/doodle-password-field';
import { AuthSocialButtons, OTP_PENDING_STORAGE_KEY } from '@/components/auth/auth-social-buttons';
import { getFirebaseClientAuth, isFirebaseClientConfigured, mapFirebaseAuthError } from '@/lib/firebase';
import { withLoader } from '@/stores/loader-store';
import { useDoodleStore } from '@/stores/doodle-store';
import { cn } from '@/lib/utils';

const LoginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormValues = z.infer<typeof LoginSchema>;

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams?.get('next') || '/overview';
  const [authError, setAuthError] = React.useState('');
  const { setFocusedField, setTyping, triggerWrongPassword, shakeKey } = useDoodleStore();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: '', password: '' },
  });

  const passwordVal = watch('password');

  const onSubmit = async (values: LoginFormValues) => {
    setAuthError('');
    if (!isFirebaseClientConfigured()) {
      const msg = 'Firebase client configuration missing in .env.local.';
      triggerWrongPassword();
      setAuthError(msg);
      toast.error(msg);
      return;
    }

    await withLoader(async () => {
      try {
        const auth = getFirebaseClientAuth();
        const cred = await signInWithEmailAndPassword(auth, values.email.trim(), values.password);
        const idToken = await cred.user.getIdToken(true);

        const res = await fetch('/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            purpose: 'login',
            name: cred.user.displayName || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Unable to send OTP verification email.');
        }

        window.sessionStorage.setItem(
          OTP_PENDING_STORAGE_KEY,
          JSON.stringify({
            email: data.email || values.email,
            purpose: 'login',
            next: nextPath,
            expiresAt: data.expiresAt,
            delivery: data.delivery,
            devCode: data.devCode,
            name: cred.user.displayName || '',
          }),
        );

        toast.success(`6-digit verification code sent to ${values.email}`);
        router.push('/verify-otp');
      } catch (err) {
        const msg = mapFirebaseAuthError(err);
        triggerWrongPassword();
        setAuthError(msg);
        toast.error(msg);
      }
    }, 'Signing in & sending email OTP…');
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12 items-stretch">
      <div className="lg:col-span-6">
        <DoodleScene customError={authError} />
      </div>
      <div
        key={shakeKey}
        className={cn(
          'lg:col-span-6 flex flex-col justify-center p-4 sm:p-8 space-y-6',
          authError && 'animate-auth-shake',
        )}
      >
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to Clipper Studio, then confirm your 6-digit email OTP.
          </p>
        </div>

        <AuthSocialButtons nextPath={nextPath} onErrorText={setAuthError} />

        <div className="relative flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Or with email
          </span>
          <Separator className="flex-1" />
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-email">Email</Label>
            <div className="relative flex items-center">
              <Mail className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-email"
                type="email"
                placeholder="you@studio.com"
                autoComplete="email"
                className="h-11 rounded-[16px] pl-10"
                {...register('email', {
                  onChange: () => setTyping(true),
                  onBlur: () => setFocusedField('none'),
                })}
                onFocus={() => setFocusedField('email')}
              />
            </div>
            {errors.email && (
              <p className="text-xs font-semibold text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="login-password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-xs font-bold text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <DoodlePasswordField
              id="login-password"
              placeholder="Enter your password"
              autoComplete="current-password"
              value={passwordVal}
              hasError={Boolean(errors.password || authError)}
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs font-semibold text-destructive">{errors.password.message}</p>
            )}
          </div>

          <div aria-live="assertive" className="min-h-[20px]">
            {authError && (
              <p className="rounded-[12px] bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
                {authError}
              </p>
            )}
          </div>

          <Button type="submit" className="h-11 w-full rounded-[16px] font-bold text-sm gap-2">
            Continue to OTP
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          New to Clipper Studio?{' '}
          <Link href="/signup" className="font-extrabold text-primary hover:underline">
            Create a creator account
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense fallback={<div className="p-10 text-center text-sm">Loading sign-in…</div>}>
      <LoginPageContent />
    </React.Suspense>
  );
}
