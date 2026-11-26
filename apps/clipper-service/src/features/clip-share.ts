import crypto from 'node:crypto';
import { getClipShare, incrementShareViewCount } from '../db.js';

/**
 * Validates access to a shared clip link.
 * Checks expiry, max view count, and optional password.
 * On success, increments the view counter and returns the clipId.
 */
export function validateClipShareAccess(
  token: string,
  password?: string,
): { valid: boolean; clipId?: string; reason?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Invalid token' };
  }

  const share = getClipShare(token);
  if (!share) {
    return { valid: false, reason: 'Share not found' };
  }

  // Check expiry
  if (share.expires_at !== null && share.expires_at !== undefined) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > share.expires_at) {
      return { valid: false, reason: 'Share link has expired' };
    }
  }

  // Check max views
  if (share.max_views !== null && share.max_views !== undefined) {
    if (share.view_count >= share.max_views) {
      return { valid: false, reason: 'Share link view limit reached' };
    }
  }

  // Check password
  if (share.password_hash) {
    if (!password) {
      return { valid: false, reason: 'Password required' };
    }
    const [salt, key] = share.password_hash.split(':');
    if (!salt || !key) {
      return { valid: false, reason: 'Share configuration error' };
    }
    const supplied = crypto.scryptSync(password, salt, 64);
    const stored = Buffer.from(key, 'hex');
    if (supplied.length !== stored.length || !crypto.timingSafeEqual(supplied, stored)) {
      return { valid: false, reason: 'Incorrect password' };
    }
  }

  incrementShareViewCount(token);
  return { valid: true, clipId: share.clip_id };
}
