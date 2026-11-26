import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'clipper_fb_session';

const PUBLIC_EXACT_ROUTES = new Set([
  '/',
  '/login',
  '/signup',
  '/verify-otp',
  '/forgot-password',
  '/reset-password',
]);

const PUBLIC_PREFIXES = ['/share/', '/api/health', '/api/auth/', '/api/webhooks/', '/api/share/'];

const PROTECTED_PREFIXES = [
  '/overview',
  '/studio',
  '/clips',
  '/queue',
  '/orders',
  '/billing',
  '/support',
  '/notifications',
  '/profile',
  '/settings',
  '/sessions',
  '/admin',
];

/**
 * Edge middleware performing fast cookie-presence checks only.
 * Full cryptographic verification, Firebase session revocation checks, and RBAC happen on the Node runtime via getSession() / requirePermission().
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.') ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (PUBLIC_EXACT_ROUTES.has(pathname)) {
    return NextResponse.next();
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isProtected && !hasSessionCookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
