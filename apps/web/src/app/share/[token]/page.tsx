'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Film, Lock, Scissors, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DoodlePasswordField } from '@/components/auth/doodle-password-field';
import { withLoader } from '@/stores/loader-store';
import { formatDuration, formatTimecode } from '@/lib/utils';

interface ShareResponse {
  requiresPassword?: boolean;
  grant?: string;
  clip?: {
    id: string;
    title: string;
    platform?: string;
    duration?: number;
    streamer?: string;
  };
  chapters?: Array<{ id: string; title: string; startSec: number }>;
  expiresAt?: string;
  error?: string;
}

export default function PublicSharePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const [data, setData] = React.useState<ShareResponse | null>(null);
  const [password, setPassword] = React.useState('');
  const [grant, setGrant] = React.useState('');
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  const loadShare = React.useCallback(async () => {
    if (!token) return;
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: 'no-store' });
    const json = (await res.json()) as ShareResponse;
    setData(json);
    if (json.grant) setGrant(json.grant);
  }, [token]);

  React.useEffect(() => {
    void loadShare();
  }, [loadShare]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    await withLoader(async () => {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json()) as ShareResponse;
      if (!res.ok) {
        toast.error(json.error || 'Incorrect share password.');
        return;
      }
      setData(json);
      if (json.grant) setGrant(json.grant);
      toast.success('Clip unlocked!');
    }, 'Unlocking shared clip…');
  };

  const streamUrl = token
    ? `/api/share/${encodeURIComponent(token)}?stream=1${grant ? `&grant=${encodeURIComponent(grant)}` : ''}`
    : '';

  return (
    <div className="min-h-screen bg-background p-4 sm:p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-4xl space-y-5">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-extrabold text-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-[12px] bg-primary text-white">
              <Scissors className="h-4 w-4" />
            </span>
            Clipper Studio Share
          </Link>
          {data?.expiresAt && (
            <Badge variant="outline" className="gap-1.5 rounded-full">
              <Timer className="h-3.5 w-3.5 text-[#FF8A30]" />
              Expires {new Date(data.expiresAt).toLocaleString()}
            </Badge>
          )}
        </div>

        <Card className="rounded-[24px] shadow-[var(--shadow-2)]">
          {!data ? (
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              Loading shared clip…
            </CardContent>
          ) : data.error ? (
            <CardContent className="p-10 text-center space-y-2">
              <p className="text-base font-extrabold text-destructive">{data.error}</p>
              <p className="text-xs text-muted-foreground">
                This share link may have expired or been revoked by its creator.
              </p>
            </CardContent>
          ) : data.requiresPassword && !grant ? (
            <CardHeader className="p-8 max-w-md mx-auto text-center space-y-4">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[16px] bg-primary/12 text-primary">
                <Lock className="h-6 w-6" />
              </div>
              <CardTitle className="text-xl font-extrabold">Password Protected Clip</CardTitle>
              <CardDescription>
                Enter the password supplied by the creator to watch this clip.
              </CardDescription>
              <form onSubmit={handleUnlock} className="space-y-4 pt-2 text-left">
                <DoodlePasswordField
                  placeholder="Enter share password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button type="submit" className="w-full h-11 rounded-[16px] font-bold">
                  Unlock Clip
                </Button>
              </form>
            </CardHeader>
          ) : (
            <CardContent className="p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-xl font-extrabold">{data.clip?.title || 'Shared Clip'}</h1>
                  <p className="text-xs text-muted-foreground">
                    {data.clip?.streamer || 'Creator'} · {formatDuration(data.clip?.duration)}
                  </p>
                </div>
                <Badge className="gap-1">
                  <Film className="h-3.5 w-3.5" /> Verified Stream
                </Badge>
              </div>

              <div className="overflow-hidden rounded-[20px] bg-black border border-border">
                <video
                  ref={videoRef}
                  src={streamUrl}
                  controls
                  playsInline
                  className="w-full max-h-[540px] object-contain"
                />
              </div>

              {Array.isArray(data.chapters) && data.chapters.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-muted-foreground">
                    Chapter Markers
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {data.chapters.map((ch) => (
                      <Button
                        key={ch.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-[12px] text-xs font-semibold"
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = ch.startSec;
                            void videoRef.current.play();
                          }
                        }}
                      >
                        <span className="font-mono text-primary mr-1.5">
                          {formatTimecode(ch.startSec)}
                        </span>
                        {ch.title}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
