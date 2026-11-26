'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup, signInWithRedirect, getRedirectResult } from 'firebase/auth';
import { FcGoogle } from 'react-icons/fc';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  createGoogleProvider,
  getFirebaseClientAuth,
  isFirebaseClientConfigured,
  mapFirebaseAuthError,
} from '@/lib/firebase';
import { withLoader } from '@/stores/loader-store';
import { useDoodleStore } from '@/stores/doodle-store';

export const OTP_PENDING_STORAGE_KEY = 'clipper_otp_pending_v1';

async function completeSocialSignInToOtp(
  user: import('firebase/auth').User,
  nextPath: string,
  router: ReturnType<typeof useRouter>,
) {
  const idToken = await user.getIdToken(true);
  const res = await fetch('/api/auth/otp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idToken,
      purpose: 'login',
      name: user.displayName || undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Could not send email verification code.');
  }

  window.sessionStorage.setItem(
    OTP_PENDING_STORAGE_KEY,
    JSON.stringify({
      email: data.email || user.email,
      purpose: 'login',
      next: nextPath,
      expiresAt: data.expiresAt,
      delivery: data.delivery,
      devCode: data.devCode,
      name: user.displayName || '',
    }),
  );

  toast.success(`Verification code sent to ${data.email || user.email}`);
  router.push('/verify-otp');
}

export function AuthSocialButtons({
  nextPath = '/overview',
  onErrorText,
}: {
  nextPath?: string;
  onErrorText?: (msg: string) => void;
}) {
  const router = useRouter();
  const triggerWrongPassword = useDoodleStore((s) => s.triggerWrongPassword);

  // Handle Google signInWithRedirect return smoothly
  React.useEffect(() => {
    if (!isFirebaseClientConfigured()) return;
    const auth = getFirebaseClientAuth();
    getRedirectResult(auth)
      .then(async (result) => {
        if (!result?.user) return;
        await withLoader(
          () => completeSocialSignInToOtp(result.user, nextPath, router),
          'Sending OTP verification code…',
        );
      })
      .catch((err) => {
        const msg = mapFirebaseAuthError(err);
        triggerWrongPassword();
        onErrorText?.(msg);
        toast.error(msg);
      });
  }, [nextPath, router, triggerWrongPassword, onErrorText]);

  const handleGoogleSignIn = async () => {
    if (!isFirebaseClientConfigured()) {
      const msg = 'Firebase Auth keys are not configured in .env.local yet.';
      triggerWrongPassword();
      onErrorText?.(msg);
      toast.error(msg);
      return;
    }

    await withLoader(async () => {
      try {
        const auth = getFirebaseClientAuth();
        const provider = createGoogleProvider();
        const result = await signInWithPopup(auth, provider);
        await completeSocialSignInToOtp(result.user, nextPath, router);
      } catch (err) {
        const code =
          typeof err === 'object' && err !== null && 'code' in err
            ? String((err as { code?: unknown }).code ?? '')
            : '';
        if (code === 'auth/popup-blocked') {
          await signInWithRedirect(getFirebaseClientAuth(), createGoogleProvider());
          return;
        }
        const msg = mapFirebaseAuthError(err);
        triggerWrongPassword();
        onErrorText?.(msg);
        toast.error(msg);
      }
    }, 'Signing in with Google…');
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleGoogleSignIn}
      className="h-11 w-full rounded-[16px] font-bold text-sm gap-2.5 border-border hover:border-primary/40"
    >
      <FcGoogle className="h-5 w-5" />
      Continue with Google
    </Button>
  );
}
