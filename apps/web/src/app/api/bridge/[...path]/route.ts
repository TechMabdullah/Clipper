import { NextResponse } from 'next/server';
import { forwardToClipperService } from '@/lib/bridge';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function handleBridge(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const first = (path[0] ?? '').toLowerCase();
  const method = req.method.toUpperCase();

  // Route-level RBAC gate before forwarding across internal bridge
  let auth;
  if (first === 'admin') {
    auth = await requirePermission('admin:access', true);
  } else if (first === 'system' && method !== 'GET') {
    auth = await requirePermission('system:maintain', true);
  } else if (first === 'billing' && method !== 'GET') {
    auth = await requirePermission('billing:manage');
  } else {
    auth = await requirePermission('clipper:use');
  }

  if (auth.errorResponse) {
    return auth.errorResponse;
  }

  try {
    return await forwardToClipperService(req, path, auth.session);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid bridge request' },
      { status: 400 },
    );
  }
}

export async function GET(req: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleBridge(req, context);
}

export async function POST(req: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleBridge(req, context);
}

export async function PUT(req: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleBridge(req, context);
}

export async function PATCH(req: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleBridge(req, context);
}

export async function DELETE(req: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleBridge(req, context);
}
