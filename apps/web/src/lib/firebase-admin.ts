import { cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

if (typeof window !== 'undefined') {
  throw new Error('firebase-admin must only be imported on the server.');
}

function resolveServiceAccount(): ServiceAccount | null {
  const rawJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (rawJson) {
    try {
      return JSON.parse(rawJson) as ServiceAccount;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }

  const projectId = (process.env.FIREBASE_PROJECT_ID ?? '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL ?? '').trim();
  const rawKey = process.env.FIREBASE_PRIVATE_KEY ?? '';
  const privateKey = rawKey.replace(/\\n/g, '\n').trim();

  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

export function isFirebaseAdminConfigured(): boolean {
  try {
    return Boolean(resolveServiceAccount());
  } catch {
    return false;
  }
}

let cachedAdminApp: App | null = null;

export function getFirebaseAdminApp(): App {
  if (cachedAdminApp) return cachedAdminApp;
  const existing = getApps()[0];
  if (existing) {
    cachedAdminApp = existing;
    return existing;
  }
  const sa = resolveServiceAccount();
  if (!sa) {
    throw new Error(
      'Firebase Admin SDK credentials are not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY (or FIREBASE_SERVICE_ACCOUNT_JSON) in .env.local.',
    );
  }
  cachedAdminApp = initializeApp({ credential: cert(sa) });
  return cachedAdminApp;
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getAdminDb(): Firestore {
  return getFirestore(getFirebaseAdminApp());
}
