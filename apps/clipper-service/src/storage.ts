import path from 'node:path';
import fs from 'node:fs';

export interface StorageInfo {
  mediaRoot: string;
  inbox: string;
  tempDir: string;
  clipsDir: string;
  archiveDir: string;
  isSingleDisk: boolean;
  activeDisk: string;
  availableDrives: string[];
}

/**
 * Returns a list of mounted/available drive root paths.
 * On Windows: e.g. ['C:\\', 'D:\\'].
 * On POSIX: ['/'].
 */
export function getAvailableDrives(): string[] {
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const drives: string[] = [];
    for (const letter of letters) {
      const d = `${letter}:\\`;
      try {
        if (fs.existsSync(d)) {
          drives.push(d);
        }
      } catch {}
    }
    return drives.length > 0 ? drives : ['C:\\'];
  }
  return ['/'];
}

/**
 * Ensures the 4 core ClipperMedia subdirectories exist.
 */
export function ensureMediaDirs(rootPath: string): void {
  const dirs = [
    rootPath,
    path.join(rootPath, '01_inbox'),
    path.join(rootPath, '02_temp'),
    path.join(rootPath, '03_clips'),
    path.join(rootPath, '04_archive'),
  ];

  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

/**
 * Intelligently resolves the media root directory:
 * - If the user has multiple disks (e.g. C: and D:/E:), prefers the secondary disk.
 * - If the user only has ONE disk (e.g. only C:), automatically creates ClipperMedia
 *   on that same disk without requiring a second disk.
 */
export function resolveMediaRootDir(preferredPath?: string): string {
  const drives = getAvailableDrives();
  const currentDrive = path.parse(process.cwd()).root; // e.g. 'D:\' or 'C:\'

  // 1. If explicit environment variable or argument provided, verify its drive exists
  const candidate = preferredPath ?? process.env.MEDIA_ROOT_DIR;
  if (candidate) {
    const resolved = path.resolve(candidate);
    const parsedRoot = path.parse(resolved).root;
    if (fs.existsSync(parsedRoot)) {
      try {
        ensureMediaDirs(resolved);
        return resolved;
      } catch (err) {
        console.warn(`[storage] Could not initialize configured MEDIA_ROOT_DIR (${candidate}):`, err);
      }
    } else {
      console.warn(`[storage] Configured drive (${parsedRoot}) does not exist on this system.`);
    }
  }

  // 2. If system has multiple disks, prefer secondary disk (non C:\)
  if (drives.length > 1) {
    const secondaryDrives = drives.filter(d => !d.toUpperCase().startsWith('C:'));
    for (const sec of secondaryDrives) {
      const secCandidate = path.join(sec, 'ClipperMedia');
      try {
        ensureMediaDirs(secCandidate);
        console.log(`[storage] Dual-disk detected: using secondary disk ${secCandidate}`);
        return secCandidate;
      } catch {}
    }
  }

  // 3. User only has ONE disk (or secondary drive is not writable):
  // Automatically create ClipperMedia on the SAME disk as the workspace/OS.
  const sameDiskRoot = path.join(currentDrive, 'ClipperMedia');
  try {
    ensureMediaDirs(sameDiskRoot);
    console.log(`[storage] Single-disk mode: ClipperMedia created on same disk: ${sameDiskRoot}`);
    return sameDiskRoot;
  } catch {
    // If root of C:\ is write-protected (non-admin), use project directory
    const fallbackProjectMedia = path.resolve(process.cwd(), 'ClipperMedia');
    ensureMediaDirs(fallbackProjectMedia);
    console.log(`[storage] Single-disk mode (local workspace): ${fallbackProjectMedia}`);
    return fallbackProjectMedia;
  }
}

// Global active storage configuration singleton
export const MEDIA_ROOT = resolveMediaRootDir();
export const INBOX = path.join(MEDIA_ROOT, '01_inbox');
export const TEMP_DIR = path.join(MEDIA_ROOT, '02_temp');
export const CLIPS_DIR = path.join(MEDIA_ROOT, '03_clips');
export const ARCHIVE_DIR = path.join(MEDIA_ROOT, '04_archive');

// Make sure directories exist on boot
ensureMediaDirs(MEDIA_ROOT);

export function getStorageInfo(): StorageInfo {
  const drives = getAvailableDrives();
  const rootDrive = path.parse(MEDIA_ROOT).root;
  return {
    mediaRoot: MEDIA_ROOT,
    inbox: INBOX,
    tempDir: TEMP_DIR,
    clipsDir: CLIPS_DIR,
    archiveDir: ARCHIVE_DIR,
    isSingleDisk: drives.length <= 1,
    activeDisk: rootDrive,
    availableDrives: drives,
  };
}
