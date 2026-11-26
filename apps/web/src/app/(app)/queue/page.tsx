'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Eye, ListVideo, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

export default function QueueAndWatchlistPage() {
  const [clipId, setClipId] = React.useState('');
  const [platform, setPlatform] = React.useState('youtube_shorts');
  const [caption, setCaption] = React.useState('');

  const [watchPlatform, setWatchPlatform] = React.useState('twitch');
  const [watchChannel, setWatchChannel] = React.useState('');

  const { data: queueRes, isLoading: loadingQueue, refetch: refetchQueue } = useQuery<{
    items?: Array<{ id: string; clipId: string; platform: string; caption?: string; status: string }>;
  }>({
    queryKey: ['bridge-upload-queue'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/queue', { cache: 'no-store' });
      return res.ok ? res.json() : { items: [] };
    },
  });

  const { data: watchRes, isLoading: loadingWatch, refetch: refetchWatch } = useQuery<{
    watchlist?: Array<{ id: string; platform: string; channel: string; autoClip: boolean; isLive?: boolean }>;
  }>({
    queryKey: ['bridge-watchlist'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/watchlist', { cache: 'no-store' });
      return res.ok ? res.json() : { watchlist: [] };
    },
  });

  const handleAddQueue = async () => {
    if (!clipId.trim()) {
      toast.error('Enter a clip ID to queue.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/bridge/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipId: clipId.trim(),
          platform,
          caption: caption.trim() || 'New Short',
        }),
      });
      if (!res.ok) {
        toast.error('Could not add to queue.');
        return;
      }
      setClipId('');
      setCaption('');
      toast.success('Added to social upload queue!');
      await refetchQueue();
    }, 'Queuing social upload…');
  };

  const handleAddWatch = async () => {
    if (!watchChannel.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: watchPlatform,
          channel: watchChannel.trim(),
          autoClip: true,
        }),
      });
      if (!res.ok) {
        toast.error('Could not add channel to watchlist.');
        return;
      }
      setWatchChannel('');
      toast.success('Added creator to auto-clip watchlist!');
      await refetchWatch();
    }, 'Updating watchlist…');
  };

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Upload Queue & Creator Watchlist
            </h1>
            <p className="text-sm text-muted-foreground">
              Schedule finished shorts across YouTube, TikTok & Reels, and auto-clip watched streamers when they go live.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => withLoader(async () => {
              await fetch('/api/bridge/watchlist/poll', { method: 'POST' });
              await refetchWatch();
              toast.success('Polled live statuses across watched channels!');
            }, 'Polling streamer live statuses…')}
            className="rounded-[16px] font-bold gap-2"
          >
            <RefreshCw className="h-4 w-4" /> Poll Live Now
          </Button>
        </div>

        <Tabs defaultValue="queue" className="space-y-5">
          <TabsList className="rounded-[16px] p-1">
            <TabsTrigger value="queue" className="rounded-[12px] font-bold">Social Queue</TabsTrigger>
            <TabsTrigger value="watchlist" className="rounded-[12px] font-bold">Live Watchlist</TabsTrigger>
          </TabsList>

          <TabsContent value="queue" className="space-y-5">
            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <ListVideo className="h-4 w-4 text-primary" /> Enqueue Social Upload
                </CardTitle>
                <CardDescription>Target clip ID, destination platform, and scheduled hook caption.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-4">
                <Input placeholder="Clip ID…" value={clipId} onChange={(e) => setClipId(e.target.value)} className="rounded-[14px]" />
                <Select value={platform} onValueChange={setPlatform}>
                  <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="youtube_shorts">YouTube Shorts</SelectItem>
                    <SelectItem value="tiktok">TikTok</SelectItem>
                    <SelectItem value="instagram_reels">Instagram Reels</SelectItem>
                    <SelectItem value="x">X / Twitter</SelectItem>
                  </SelectContent>
                </Select>
                <Input placeholder="Social caption & hashtags…" value={caption} onChange={(e) => setCaption(e.target.value)} className="rounded-[14px]" />
                <Button onClick={handleAddQueue} className="rounded-[14px] font-bold gap-1.5">
                  <Send className="h-4 w-4" /> Add to Queue
                </Button>
              </CardContent>
            </Card>

            <MinReveal ready={!loadingQueue} fallback={<SkeletonList items={4} />}>
              <div className="space-y-3">
                {(queueRes?.items ?? []).length === 0 ? (
                  <Card className="rounded-[22px] p-8 text-center text-sm text-muted-foreground">
                    Social upload queue is currently empty.
                  </Card>
                ) : (
                  (queueRes?.items ?? []).map((item) => (
                    <Card key={item.id} className="rounded-[20px] p-4 flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[10px] uppercase">{item.platform}</Badge>
                          <Badge variant={item.status === 'uploaded' ? 'default' : 'outline'}>{item.status}</Badge>
                        </div>
                        <p className="mt-1 text-sm font-bold">{item.caption || item.clipId}</p>
                        <p className="text-xs font-mono text-muted-foreground">Clip: {item.clipId}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.status !== 'uploaded' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              await fetch(`/api/bridge/queue/${encodeURIComponent(item.id)}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ status: 'uploaded' }),
                              });
                              await refetchQueue();
                            }}
                            className="rounded-[12px] gap-1 text-xs"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Mark Published
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-destructive"
                          onClick={async () => {
                            await fetch(`/api/bridge/queue/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
                            await refetchQueue();
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            </MinReveal>
          </TabsContent>

          <TabsContent value="watchlist" className="space-y-5">
            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <Eye className="h-4 w-4 text-[#FF8A30]" /> Add Channel to Auto-Clip Watchlist
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-3">
                <Select value={watchPlatform} onValueChange={setWatchPlatform}>
                  <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="twitch">Twitch</SelectItem>
                    <SelectItem value="kick">Kick</SelectItem>
                    <SelectItem value="youtube">YouTube</SelectItem>
                  </SelectContent>
                </Select>
                <Input placeholder="Streamer handle…" value={watchChannel} onChange={(e) => setWatchChannel(e.target.value)} className="rounded-[14px]" />
                <Button onClick={handleAddWatch} className="rounded-[14px] font-bold gap-1.5">
                  <Plus className="h-4 w-4" /> Watch Channel
                </Button>
              </CardContent>
            </Card>

            <MinReveal ready={!loadingWatch} fallback={<SkeletonList items={3} />}>
              <div className="space-y-3">
                {(watchRes?.watchlist ?? []).map((w) => (
                  <Card key={w.id} className="rounded-[20px] p-4 flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="uppercase text-[10px]">{w.platform}</Badge>
                        {w.isLive && <Badge className="bg-emerald-500 text-white">LIVE NOW</Badge>}
                      </div>
                      <p className="mt-1 text-sm font-extrabold">{w.channel}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={w.autoClip}
                        onCheckedChange={async (checked) => {
                          await fetch(`/api/bridge/watchlist/${encodeURIComponent(w.id)}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ autoClip: checked }),
                          });
                          await refetchWatch();
                        }}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        onClick={async () => {
                          await fetch(`/api/bridge/watchlist/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
                          await refetchWatch();
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </MinReveal>
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
