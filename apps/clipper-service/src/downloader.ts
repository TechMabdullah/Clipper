import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { INBOX } from './storage.js';

const YTDLP = process.env.YTDLP_BIN_PATH ?? 'yt-dlp';

/**
 * Downloads a URL to 01_inbox/ using yt-dlp.
 * Returns the final file path.
 */
export function downloadUrl(url: string, jobId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outTemplate = path.join(INBOX, `${jobId}.%(ext)s`);
    const args = [
      url,
      '--output', outTemplate,
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--quiet',
      '--progress',
    ];

    console.log(`[downloader] yt-dlp ${url}`);
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}`));

      // Find the file yt-dlp actually wrote
      const files = fs.readdirSync(INBOX).filter((f) => f.startsWith(jobId));
      if (!files.length) return reject(new Error('yt-dlp wrote no output file'));
      resolve(path.join(INBOX, files[0]!));
    });
  });
}

/**
 * Returns the duration of a video in seconds using ffprobe.
 */
export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const j = JSON.parse(out) as { format: { duration: string } };
        resolve(parseFloat(j.format.duration));
      } catch {
        reject(new Error('ffprobe JSON parse failed'));
      }
    });
  });
}
