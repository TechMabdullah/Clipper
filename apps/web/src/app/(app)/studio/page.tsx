'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CalendarClock,
  Cpu,
  Download,
  Film,
  Flame,
  Music,
  Play,
  Plus,
  Radio,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PageTransition } from '@/components/motion/page-transition';
import { withLoader } from '@/stores/loader-store';
import { formatDuration } from '@/lib/utils';
import { triggerCelebrationConfetti } from '@/lib/confetti';
import { LivePulseRadar, AudioEqualizerBars } from '@/components/animated/live-pulse';

export default function StudioPage() {
  const queryClient = useQueryClient();

  // Live capture state
  const [livePlatform, setLivePlatform] = React.useState('twitch');
  const [liveChannel, setLiveChannel] = React.useState('');
  const [liveLayout, setLiveLayout] = React.useState('split_facecam');
  const [liveCaptionStyle, setLiveCaptionStyle] = React.useState('bold_pop');
  const [triggerTitle, setTriggerTitle] = React.useState('');
  const [liveChatLines, setLiveChatLines] = React.useState<string[]>([]);

  // Quick Clipper Job state
  const [jobUrl, setJobUrl] = React.useState('');
  const [jobCount, setJobCount] = React.useState('3');
  const [jobLog, setJobLog] = React.useState<string[]>([]);

  // VOD Studio state
  const [vodUrl, setVodUrl] = React.useState('');
  const [selectedVideoPath, setSelectedVideoPath] = React.useState('');
  const [cutStart, setCutStart] = React.useState('0');
  const [cutEnd, setCutEnd] = React.useState('35');
  const [cutTitle, setCutTitle] = React.useState('');
  const [cutLayout, setCutLayout] = React.useState('split_facecam');
  const [peaks, setPeaks] = React.useState<Array<{ startSec: number; score: number }>>([]);
  const [detectedFace, setDetectedFace] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  // Presets & Schedules
  const [presetName, setPresetName] = React.useState('');
  const [schedCron, setSchedCron] = React.useState('0 */2 * * *');
  const [schedUrl, setSchedUrl] = React.useState('');

  const { data: liveStatus, refetch: refetchLive } = useQuery<{
    active?: boolean;
    platform?: string;
    channel?: string;
    clipsTriggered?: number;
  }>({
    queryKey: ['bridge-live-status'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/live/status', { cache: 'no-store' });
      return res.ok ? res.json() : { active: false };
    },
    refetchInterval: 8_000,
  });

  const { data: liveHealth } = useQuery<{
    snapshots?: Array<{ bitrateKbps?: number; fps?: number; droppedFrames?: number; capturedAt?: string }>;
  }>({
    queryKey: ['bridge-live-health'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/live/health', { cache: 'no-store' });
      return res.ok ? res.json() : { snapshots: [] };
    },
    refetchInterval: 15_000,
  });

  const { data: studioVideos, refetch: refetchVideos } = useQuery<{
    videos?: Array<{ name: string; path: string; sizeBytes?: number; durationSec?: number }>;
  }>({
    queryKey: ['bridge-studio-videos'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/studio/videos', { cache: 'no-store' });
      return res.ok ? res.json() : { videos: [] };
    },
  });

  const { data: presetsData, refetch: refetchPresets } = useQuery<{
    presets?: Array<{ id: string; name: string; layout?: string; captionStyle?: string }>;
  }>({
    queryKey: ['bridge-presets'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/presets', { cache: 'no-store' });
      return res.ok ? res.json() : { presets: [] };
    },
  });

  const { data: scheduledData, refetch: refetchSchedules } = useQuery<{
    jobs?: Array<{ id: string; url: string; cron: string; enabled: boolean }>;
  }>({
    queryKey: ['bridge-scheduled'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/scheduled', { cache: 'no-store' });
      return res.ok ? res.json() : { jobs: [] };
    },
  });

  const { data: musicData } = useQuery<{ tracks?: Array<{ name: string; path: string }> }>({
    queryKey: ['bridge-studio-music'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/studio/music', { cache: 'no-store' });
      return res.ok ? res.json() : { tracks: [] };
    },
  });

  // Live Chat SSE when active
  React.useEffect(() => {
    if (!liveStatus?.active) return;
    const es = new EventSource('/api/bridge/live/chat/stream');
    es.onmessage = (evt) => {
      setLiveChatLines((prev) => [evt.data, ...prev].slice(0, 30));
    };
    return () => es.close();
  }, [liveStatus?.active]);

  const handleStartLive = async () => {
    if (!liveChannel.trim()) {
      toast.error('Enter a Twitch, Kick, or YouTube channel handle.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/bridge/live/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: livePlatform,
          channel: liveChannel.trim(),
          layout: liveLayout,
          captionStyle: liveCaptionStyle,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Could not start live capture.');
        return;
      }
      toast.success(`Live capture started on ${livePlatform}/${liveChannel}`);
      await refetchLive();
    }, 'Starting live stream capture…');
  };

  const handleStopLive = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/bridge/live/stop', { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to stop capture.');
        return;
      }
      toast.success('Live capture stopped safely.');
      await refetchLive();
    }, 'Stopping live capture…');
  };

  const handleManualLiveTrigger = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/bridge/live/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: triggerTitle.trim() || 'Live Hype Moment' }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Trigger failed.');
        return;
      }
      toast.success('Instant live clip triggered!');
      triggerCelebrationConfetti();
      setTriggerTitle('');
      void queryClient.invalidateQueries({ queryKey: ['bridge-clips-overview'] });
    }, 'Triggering live highlight clip…');
  };

  const handleDownloadVod = async () => {
    if (!vodUrl.trim()) {
      toast.error('Enter a Twitch, Kick, or YouTube VOD URL.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/bridge/studio/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: vodUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'VOD download failed.');
        return;
      }
      toast.success('VOD download queued!');
      setVodUrl('');
      await refetchVideos();
    }, 'Queuing VOD download via yt-dlp…');
  };

  const handleDetectFacecam = async () => {
    if (!selectedVideoPath) return;
    const t = Math.floor(videoRef.current?.currentTime ?? 5);
    await withLoader(async () => {
      const res = await fetch('/api/bridge/studio/detect-facecam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: selectedVideoPath, timestampSec: t }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Facecam detection failed.');
        return;
      }
      if (data.box) setDetectedFace(data.box);
      toast.success('AI BlazeFace coordinates locked!');
    }, 'Detecting webcam face region…');
  };

  const handleScanPeaks = async () => {
    if (!selectedVideoPath) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/studio/audio-peaks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: selectedVideoPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Peak scan failed.');
        return;
      }
      setPeaks(Array.isArray(data.peaks) ? data.peaks : []);
      toast.success(`Found ${(data.peaks ?? []).length} high-energy audio spikes!`);
    }, 'Scanning audio waveform peaks…');
  };

  const handleCutManualClip = async () => {
    if (!selectedVideoPath) {
      toast.error('Select a local recording or VOD first.');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/bridge/studio/cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: selectedVideoPath,
          startSec: Number(cutStart),
          endSec: Number(cutEnd),
          title: cutTitle.trim() || 'Studio Cut',
          layout: cutLayout,
          faceBox: detectedFace,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Cut failed.');
        return;
      }
      toast.success('Manual clip exported to Library!');
    }, 'Rendering vertical short with FFmpeg…');
  };

  const handleAutoClip = async () => {
    if (!selectedVideoPath) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/studio/auto-clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: selectedVideoPath, maxClips: 3 }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Auto-clip failed.');
        return;
      }
      toast.success(`Auto-generated ${(data.clips ?? []).length || 3} highlight clips!`);
      triggerCelebrationConfetti();
    }, 'Auto-clipping peak highlights…');
  };

  const handleSubmitJob = async () => {
    if (!jobUrl.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/clipper/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: jobUrl.trim(), maxClips: Number(jobCount) || 3 }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to enqueue job.');
        return;
      }
      toast.success(`Clip job queued (${data.jobId || 'OK'})`);
      if (data.jobId) {
        const es = new EventSource(`/api/bridge/clipper/jobs/${encodeURIComponent(data.jobId)}/progress`);
        es.onmessage = (evt) => {
          setJobLog((prev) => [evt.data, ...prev].slice(0, 20));
        };
        es.onerror = () => es.close();
      }
    }, 'Queuing AI Clipper pipeline job…');
  };

  const handleSavePreset = async () => {
    if (!presetName.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: presetName.trim(),
          layout: liveLayout,
          captionStyle: liveCaptionStyle,
        }),
      });
      if (!res.ok) {
        toast.error('Could not save preset.');
        return;
      }
      setPresetName('');
      toast.success('Studio preset saved!');
      await refetchPresets();
    }, 'Saving studio preset…');
  };

  const handleAddSchedule = async () => {
    if (!schedUrl.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/scheduled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: schedUrl.trim(), cron: schedCron }),
      });
      if (!res.ok) {
        toast.error('Could not schedule job.');
        return;
      }
      setSchedUrl('');
      toast.success('Recurring cron job created!');
      await refetchSchedules();
    }, 'Saving cron schedule…');
  };

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Studio & Live Clipper
            </h1>
            <p className="text-sm text-muted-foreground">
              Real-time stream capture, AI BlazeFace split-cam, VOD waveform peaks, presets, and cron schedules.
            </p>
          </div>
          <Badge variant={liveStatus?.active ? 'default' : 'secondary'} className="rounded-full px-3 py-1 text-xs font-bold gap-1.5">
            {liveStatus?.active ? <LivePulseRadar size="sm" color="red" /> : <Radio className="h-3.5 w-3.5" />}
            {liveStatus?.active ? `LIVE: ${liveStatus.channel}` : 'Capture Idle'}
          </Badge>
        </div>

        <Tabs defaultValue="live" className="space-y-5">
          <TabsList className="rounded-[16px] p-1">
            <TabsTrigger value="live" className="rounded-[12px] font-bold">Live Capture</TabsTrigger>
            <TabsTrigger value="vod" className="rounded-[12px] font-bold">VOD Workbench</TabsTrigger>
            <TabsTrigger value="jobs" className="rounded-[12px] font-bold">Jobs, Presets & Cron</TabsTrigger>
          </TabsList>

          {/* TAB 1: LIVE CAPTURE */}
          <TabsContent value="live" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg font-extrabold">
                    <Radio className="h-5 w-5 text-primary" /> Live Stream Monitor
                  </CardTitle>
                  <CardDescription>
                    Monitor live Twitch, Kick, or YouTube chat spikes and capture highlight clips automatically.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Platform</Label>
                      <Select value={livePlatform} onValueChange={setLivePlatform}>
                        <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="twitch">Twitch</SelectItem>
                          <SelectItem value="kick">Kick</SelectItem>
                          <SelectItem value="youtube">YouTube Live</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Channel Handle</Label>
                      <Input
                        placeholder="e.g. kaicenat or shroud"
                        value={liveChannel}
                        onChange={(e) => setLiveChannel(e.target.value)}
                        className="rounded-[14px]"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Vertical Layout</Label>
                      <Select value={liveLayout} onValueChange={setLiveLayout}>
                        <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="split_facecam">Split Screen (AI Facecam Top)</SelectItem>
                          <SelectItem value="center_crop">Center 9:16 Action Crop</SelectItem>
                          <SelectItem value="blurred_bg">16:9 Fit + Blurred BG</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Caption Style</Label>
                      <Select value={liveCaptionStyle} onValueChange={setLiveCaptionStyle}>
                        <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bold_pop">Bold Word Pop</SelectItem>
                          <SelectItem value="neon_glow">Neon Highlight</SelectItem>
                          <SelectItem value="minimal_clean">Minimal Clean</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3 pt-2">
                    {!liveStatus?.active ? (
                      <Button onClick={handleStartLive} className="rounded-[16px] font-bold gap-2">
                        <Play className="h-4 w-4" /> Start Live Capture
                      </Button>
                    ) : (
                      <Button variant="destructive" onClick={handleStopLive} className="rounded-[16px] font-bold gap-2">
                        <Square className="h-4 w-4" /> Stop Capture
                      </Button>
                    )}
                    <div className="flex flex-1 gap-2 min-w-[200px]">
                      <Input
                        placeholder="Quick trigger title…"
                        value={triggerTitle}
                        onChange={(e) => setTriggerTitle(e.target.value)}
                        className="rounded-[14px]"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleManualLiveTrigger}
                        className="rounded-[14px] font-bold gap-1.5 shrink-0"
                      >
                        <Scissors className="h-4 w-4" /> Trigger Clip
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg font-extrabold">
                    <Activity className="h-5 w-5 text-[#FF8A30]" /> 15s Stream Health & Live Chat SSE
                  </CardTitle>
                  <CardDescription>
                    Real-time encoder telemetry and chat velocity events.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    {(liveHealth?.snapshots?.slice(0, 1) ?? [{ bitrateKbps: 0, fps: 0, droppedFrames: 0 }]).map((snap, i) => (
                      <React.Fragment key={i}>
                        <div className="rounded-[16px] bg-muted/45 p-3">
                          <p className="text-[11px] font-bold text-muted-foreground">Bitrate</p>
                          <p className="text-lg font-extrabold">{snap.bitrateKbps ?? 0} kbps</p>
                        </div>
                        <div className="rounded-[16px] bg-muted/45 p-3">
                          <p className="text-[11px] font-bold text-muted-foreground">FPS</p>
                          <p className="text-lg font-extrabold">{snap.fps ?? 0}</p>
                        </div>
                        <div className="rounded-[16px] bg-muted/45 p-3">
                          <p className="text-[11px] font-bold text-muted-foreground">Dropped</p>
                          <p className="text-lg font-extrabold">{snap.droppedFrames ?? 0}</p>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                  <div className="h-44 overflow-y-auto rounded-[16px] border border-border bg-muted/30 p-3 font-mono text-xs space-y-1">
                    {liveChatLines.length === 0 ? (
                      <p className="text-muted-foreground">
                        Start a live capture session to see real-time chat velocity spikes here…
                      </p>
                    ) : (
                      liveChatLines.map((line, i) => (
                        <div key={i} className="truncate">{line}</div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* TAB 2: VOD WORKBENCH */}
          <TabsContent value="vod" className="space-y-6">
            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg font-extrabold">
                  <Download className="h-5 w-5 text-primary" /> Download VOD or Select Local Recording
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 lg:grid-cols-2">
                <div className="flex gap-2">
                  <Input
                    placeholder="Paste Twitch/Kick/YouTube VOD URL…"
                    value={vodUrl}
                    onChange={(e) => setVodUrl(e.target.value)}
                    className="rounded-[16px]"
                  />
                  <Button onClick={handleDownloadVod} className="rounded-[16px] font-bold shrink-0">
                    Fetch VOD
                  </Button>
                </div>
                <Select value={selectedVideoPath} onValueChange={setSelectedVideoPath}>
                  <SelectTrigger className="rounded-[16px]">
                    <SelectValue placeholder="Choose downloaded/local video to edit…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(studioVideos?.videos ?? []).map((v) => (
                      <SelectItem key={v.path} value={v.path}>
                        {v.name} ({formatDuration(v.durationSec)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-12">
              <Card className="rounded-[24px] lg:col-span-7 shadow-[var(--shadow-sm)]">
                <CardHeader>
                  <CardTitle className="text-base font-extrabold">Video Preview & Facecam Box</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="overflow-hidden rounded-[18px] border border-border bg-black">
                    {selectedVideoPath ? (
                      <video
                        ref={videoRef}
                        src={`/api/bridge/studio/videos/stream?path=${encodeURIComponent(selectedVideoPath)}`}
                        controls
                        className="w-full max-h-[380px] object-contain"
                      />
                    ) : (
                      <div className="flex h-64 items-center justify-center text-xs text-white/60">
                        Select a recording above to inspect timeline, detect facecam & cut clips.
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!selectedVideoPath}
                      onClick={handleDetectFacecam}
                      className="rounded-[14px] font-bold gap-1.5"
                    >
                      <Cpu className="h-4 w-4 text-primary" /> Auto-Detect Facecam
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!selectedVideoPath}
                      onClick={handleScanPeaks}
                      className="rounded-[14px] font-bold gap-1.5"
                    >
                      <Flame className="h-4 w-4 text-[#FF8A30]" /> Scan Audio Peaks
                    </Button>
                    <Button
                      size="sm"
                      disabled={!selectedVideoPath}
                      onClick={handleAutoClip}
                      className="rounded-[14px] font-bold gap-1.5"
                    >
                      <Wand2 className="h-4 w-4" /> AI Auto-Clip Top 3
                    </Button>
                  </div>
                  {detectedFace && (
                    <p className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                      Facebox locked: x={detectedFace.x}, y={detectedFace.y}, {detectedFace.w}×{detectedFace.h}
                    </p>
                  )}
                  {peaks.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {peaks.slice(0, 8).map((p, idx) => (
                        <Button
                          key={idx}
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="rounded-[10px] text-xs"
                          onClick={() => {
                            setCutStart(String(Math.max(0, Math.floor(p.startSec - 5))));
                            setCutEnd(String(Math.floor(p.startSec + 25)));
                            if (videoRef.current) videoRef.current.currentTime = p.startSec;
                          }}
                        >
                          Peak {formatDuration(p.startSec)} ({Math.round(p.score)})
                        </Button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-[24px] lg:col-span-5 shadow-[var(--shadow-sm)]">
                <CardHeader>
                  <CardTitle className="text-base font-extrabold">Manual Cut & Music Mix</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>Clip Title</Label>
                    <Input
                      placeholder="Insane clutch 1v4"
                      value={cutTitle}
                      onChange={(e) => setCutTitle(e.target.value)}
                      className="rounded-[14px]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Start (sec)</Label>
                      <Input
                        type="number"
                        value={cutStart}
                        onChange={(e) => setCutStart(e.target.value)}
                        className="rounded-[14px]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>End (sec)</Label>
                      <Input
                        type="number"
                        value={cutEnd}
                        onChange={(e) => setCutEnd(e.target.value)}
                        className="rounded-[14px]"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Layout</Label>
                    <Select value={cutLayout} onValueChange={setCutLayout}>
                      <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="split_facecam">Split Screen Facecam</SelectItem>
                        <SelectItem value="center_crop">Center 9:16 Crop</SelectItem>
                        <SelectItem value="blurred_bg">Blurred Frame</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-[16px] bg-muted/40 p-3 text-xs space-y-1">
                    <p className="font-bold flex items-center gap-1.5">
                      <Music className="h-3.5 w-3.5 text-primary" /> Background Audio Library
                    </p>
                    <p className="text-muted-foreground">
                      {(musicData?.tracks ?? []).length} audio tracks ready for mixing.
                    </p>
                  </div>
                  <Button
                    disabled={!selectedVideoPath}
                    onClick={handleCutManualClip}
                    className="w-full h-11 rounded-[16px] font-bold gap-2"
                  >
                    <Scissors className="h-4 w-4" /> Export Vertical Short
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* TAB 3: JOBS, PRESETS, SCHEDULES */}
          <TabsContent value="jobs" className="grid gap-6 lg:grid-cols-3">
            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <Film className="h-4 w-4 text-primary" /> Quick URL Pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="YouTube / Twitch clip or VOD URL…"
                  value={jobUrl}
                  onChange={(e) => setJobUrl(e.target.value)}
                  className="rounded-[14px]"
                />
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={jobCount}
                  onChange={(e) => setJobCount(e.target.value)}
                  className="rounded-[14px]"
                />
                <Button onClick={handleSubmitJob} className="w-full rounded-[14px] font-bold gap-1.5">
                  <Sparkles className="h-4 w-4" /> Run AI Clipper Job
                </Button>
                {jobLog.length > 0 && (
                  <div className="max-h-36 overflow-y-auto rounded-[12px] bg-muted/50 p-2.5 font-mono text-[11px] space-y-1">
                    {jobLog.map((l, i) => (
                      <div key={i} className="truncate">{l}</div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="text-base font-extrabold">Saved Studio Presets</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    placeholder="Preset name…"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    className="rounded-[14px]"
                  />
                  <Button size="icon" onClick={handleSavePreset} className="rounded-[14px] shrink-0">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="space-y-2">
                  {(presetsData?.presets ?? []).map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-[12px] border border-border px-3 py-2 text-xs"
                    >
                      <div>
                        <p className="font-bold">{p.name}</p>
                        <p className="text-muted-foreground">{p.layout} · {p.captionStyle}</p>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={async () => {
                          await fetch(`/api/bridge/presets/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
                          await refetchPresets();
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <CalendarClock className="h-4 w-4 text-[#FF8A30]" /> Scheduled Cron Jobs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="Channel or playlist URL…"
                  value={schedUrl}
                  onChange={(e) => setSchedUrl(e.target.value)}
                  className="rounded-[14px]"
                />
                <div className="flex gap-2">
                  <Input
                    value={schedCron}
                    onChange={(e) => setSchedCron(e.target.value)}
                    className="rounded-[14px] font-mono text-xs"
                  />
                  <Button onClick={handleAddSchedule} className="rounded-[14px] font-bold shrink-0">
                    Schedule
                  </Button>
                </div>
                <div className="space-y-2">
                  {(scheduledData?.jobs ?? []).map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center justify-between rounded-[12px] border border-border px-3 py-2 text-xs gap-2"
                    >
                      <div className="min-w-0">
                        <p className="font-bold truncate">{j.url}</p>
                        <p className="font-mono text-muted-foreground">{j.cron}</p>
                      </div>
                      <Switch
                        checked={j.enabled}
                        onCheckedChange={async () => {
                          await fetch(`/api/bridge/scheduled/${encodeURIComponent(j.id)}/toggle`, {
                            method: 'PATCH',
                          });
                          await refetchSchedules();
                        }}
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
