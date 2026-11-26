'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { ArrowRight, Mail, User } from 'lucide-react';
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

const SignupSchema = z
  .object({
    name: z.string().min(2, 'Enter your name (at least 2 characters)').max(80),
    email: z.string().email('Enter a valid email address'),
    password: z
      .string()
      .min(8, 'Use at least 8 characters')
      .regex(/[A-Za-z]/, 'Include at least one letter')
      .regex(/[0-9]/, 'Include at least one number'),
    confirmPassword: z.string().min(8),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

type SignupValues = z.infer<typeof SignupSchema>;

export default function SignupPage() {
  const router = useRouter();
  const [authError, setAuthError] = React.useState('');
  const { setFocusedField, setTyping, triggerWrongPassword, shakeKey } = useDoodleStore();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<SignupValues>({
    resolver: zodResolver(SignupSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });

  const passwordVal = watch('password');
  const confirmVal = watch('confirmPassword');

  const onSubmit = async (values: SignupValues) => {
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
        const cred = await createUserWithEmailAndPassword(
          auth,
          values.email.trim(),
          values.password,
        );
        await updateProfile(cred.user, { displayName: values.name.trim() });
        const idToken = await cred.user.getIdToken(true);

        const res = await fetch('/api/auth/otp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            purpose: 'signup',
            name: values.name.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Could not send OTP email.');
        }

        window.sessionStorage.setItem(
          OTP_PENDING_STORAGE_KEY,
          JSON.stringify({
            email: data.email || values.email,
            purpose: 'signup',
            next: '/overview',
            expiresAt: data.expiresAt,
            delivery: data.delivery,
            devCode: data.devCode,
            name: values.name.trim(),
          }),
        );

        toast.success(`Account created! Enter the 6-digit code sent to ${values.email}`);
        router.push('/verify-otp');
      } catch (err) {
        const msg = mapFirebaseAuthError(err);
        triggerWrongPassword();
        setAuthError(msg);
        toast.error(msg);
      }
    }, 'Creating creator account & sending OTP…');
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12 items-stretch">
      <div className="lg:col-span-6">
        <DoodleScene customError={authError} />
      </div>
      <div
        key={shakeKey}
        className={cn(
          'lg:col-span-6 flex flex-col justify-center p-4 sm:p-8 space-y-5',
          authError && 'animate-auth-shake',
        )}
      >
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Create your studio
          </h1>
          <p className="text-sm text-muted-foreground">
            Start clipping live streams & VODs in seconds with verified security.
          </p>
        </div>

        <AuthSocialButtons nextPath="/overview" onErrorText={setAuthError} />

        <div className="relative flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Or sign up with email
          </span>
          <Separator className="flex-1" />
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="signup-name">Creator Name</Label>
            <div className="relative flex items-center">
              <User className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="signup-name"
                placeholder="Alex Rivera"
                className="h-11 rounded-[16px] pl-10"
                {...register('name', {
                  onChange: () => setTyping(true),
                  onBlur: () => setFocusedField('none'),
                })}
                onFocus={() => setFocusedField('name')}
              />
            </div>
            {errors.name && (
              <p className="text-xs font-semibold text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signup-email">Email</Label>
            <div className="relative flex items-center">
              <Mail className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="signup-email"
                type="email"
                placeholder="alex@creator.io"
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

          <div className="space-y-1.5">
            <Label htmlFor="signup-password">Password</Label>
            <DoodlePasswordField
              id="signup-password"
              fieldKey="password"
              showStrength
              placeholder="Min 8 chars, letters + numbers"
              value={passwordVal}
              hasError={Boolean(errors.password)}
              {...register('password')}
            />
            {errors.password && (
              <p className="text-xs font-semibold text-destructive">{errors.password.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signup-confirm">Confirm Password</Label>
            <DoodlePasswordField
              id="signup-confirm"
              fieldKey="confirm"
              placeholder="Repeat password"
              value={confirmVal}
              hasError={Boolean(errors.confirmPassword)}
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && (
              <p className="text-xs font-semibold text-destructive">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>

          <div aria-live="assertive">
            {authError && (
              <p className="rounded-[12px] bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
                {authError}
              </p>
            )}
          </div>

          <Button type="submit" className="h-11 w-full rounded-[16px] font-bold text-sm gap-2">
            Create Account & Verify Email
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-extrabold text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
