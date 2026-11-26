import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  signOut,
  type Auth,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
};

export function isFirebaseClientConfigured(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  );
}

let cachedApp: FirebaseApp | null = null;

export function getFirebaseClientApp(): FirebaseApp {
  if (!isFirebaseClientConfigured()) {
    throw new Error(
      'Firebase client environment variables (NEXT_PUBLIC_FIREBASE_*) are not configured in .env.local.',
    );
  }
  if (cachedApp) return cachedApp;
  cachedApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return cachedApp;
}

export function getFirebaseClientAuth(): Auth {
  return getAuth(getFirebaseClientApp());
}

export function getFirebaseClientDb(): Firestore {
  return getFirestore(getFirebaseClientApp());
}

export function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

export function createGithubProvider(): GithubAuthProvider {
  const provider = new GithubAuthProvider();
  provider.addScope('user:email');
  return provider;
}

export function mapFirebaseAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');

  switch (code) {
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with the same email using another sign-in provider (Google, GitHub, or password). Sign in with that original method first, then link providers in Profile.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in window was closed before completing authentication.';
    case 'auth/network-request-failed':
      return 'Network error while contacting authentication servers. Check your connection and retry.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 8 characters with letters and numbers.';
    case 'auth/too-many-requests':
      return 'Too many attempts detected. Please wait a minute and try again.';
    case 'auth/user-disabled':
      return 'This account has been disabled by an administrator.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email or password. Please double-check and try again.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in instead.';
    case 'auth/requires-recent-login':
      return 'Please re-authenticate before performing this sensitive account action.';
    default:
      return msg || 'Authentication failed. Please try again.';
  }
}

export async function signOutClient(): Promise<void> {
  if (!isFirebaseClientConfigured()) return;
  try {
    await signOut(getFirebaseClientAuth());
  } catch {
    // Non-fatal during sign-out cleanup
  }
}
