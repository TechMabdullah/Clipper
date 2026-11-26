'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useQueryState } from 'nuqs';
import {
  Archive,
  BookmarkCheck,
  Copy,
  Download,
  FlaskConical,
  FolderPlus,
  Heart,
  Link2,
  MessageSquare,
  Plus,
  Search,
  Share2,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { PageTransition } from '@/components/motion/page-transition';
import { ClipsLoadingFallback } from './clips-skeleton-helper';
import { withLoader } from '@/stores/loader-store';
import { serializeSafeCsv } from '@/lib/csv';
import { formatDuration, formatTimecode, cn } from '@/lib/utils';
import { triggerCelebrationConfetti, triggerSuccessBurst } from '@/lib/confetti';

interface ClipRecord {
  id: string;
  title?: string;
  platform?: string;
  duration?: number;
  score?: number;
  rating?: number;
  favorite?: boolean;
  archived?: boolean;
  streamer?: string;
  tags?: string[];
  notes?: string;
  createdAt?: string;
}

export default function ClipsLibraryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useQueryState('q', { defaultValue: '' });
  const [collectionFilter, setCollectionFilter] = useQueryState('col', { defaultValue: 'all' });
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [activeClip, setActiveClip] = React.useState<ClipRecord | null>(null);
  const [newCollectionName, setNewCollectionName] = React.useState('');
  const [chapterTitle, setChapterTitle] = React.useState('');
  const [chapterTime, setChapterTime] = React.useState('5');
  const [commentText, setCommentText] = React.useState('');
  const [sharePassword, setSharePassword] = React.useState('');
  const [abTitleA, setAbTitleA] = React.useState('');
  const [abTitleB, setAbTitleB] = React.useState('');

  const { data: clipsRes, isLoading: loadingClips } = useQuery<{ clips?: ClipRecord[] }>({
    queryKey: ['bridge-clips-library'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/clips', { cache: 'no-store' });
      return res.ok ? res.json() : { clips: [] };
    },
  });

  const { data: collectionsRes, refetch: refetchCollections } = useQuery<{
    collections?: Array<{ id: string; name: string; color?: string }>;
  }>({
    queryKey: ['bridge-collections'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/collections', { cache: 'no-store' });
      return res.ok ? res.json() : { collections: [] };
    },
  });

  const { data: chaptersRes, refetch: refetchChapters } = useQuery<{
    chapters?: Array<{ id: string; title: string; startSec: number }>;
  }>({
    queryKey: ['clip-chapters', activeClip?.id],
    enabled: Boolean(activeClip?.id),
    queryFn: async () => {
      const res = await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip!.id)}/chapters`);
      return res.ok ? res.json() : { chapters: [] };
    },
  });

  const { data: commentsRes, refetch: refetchComments } = useQuery<{
    comments?: Array<{ id: string; author?: string; body: string; timestampSec?: number; resolved?: boolean }>;
  }>({
    queryKey: ['clip-comments', activeClip?.id],
    enabled: Boolean(activeClip?.id),
    queryFn: async () => {
      const res = await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip!.id)}/comments`);
      return res.ok ? res.json() : { comments: [] };
    },
  });

  const { data: sharesRes, refetch: refetchShares } = useQuery<{
    shares?: Array<{ token: string; expiresAt?: string; hasPassword?: boolean }>;
  }>({
    queryKey: ['clip-shares', activeClip?.id],
    enabled: Boolean(activeClip?.id),
    queryFn: async () => {
      const res = await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip!.id)}/shares`);
      return res.ok ? res.json() : { shares: [] };
    },
  });

  const { data: abRes, refetch: refetchAb } = useQuery<{
    experiments?: Array<{ id: string; variantA: string; variantB: string; winner?: string }>;
  }>({
    queryKey: ['clip-ab', activeClip?.id],
    enabled: Boolean(activeClip?.id),
    queryFn: async () => {
      const res = await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip!.id)}/ab-tests`);
      return res.ok ? res.json() : { experiments: [] };
    },
  });

  const clips = React.useMemo(() => {
    const raw = clipsRes?.clips ?? [];
    return raw.filter((c) => {
      if (collectionFilter === 'archived') {
        if (!c.archived) return false;
      } else {
        if (c.archived) return false;
        if (collectionFilter === 'top_rated' && (c.rating ?? 0) < 4) return false;
      }
      if (search.trim()) {
        const hay = `${c.title ?? ''} ${c.streamer ?? ''} ${c.platform ?? ''} ${(c.tags ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [clipsRes?.clips, collectionFilter, search]);

  const handleRate = async (clipId: string, rating: number) => {
    await fetch(`/api/bridge/clips/${encodeURIComponent(clipId)}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating }),
    });
    toast.success(`Rated clip ${rating}★`);
    triggerSuccessBurst();
    void queryClient.invalidateQueries({ queryKey: ['bridge-clips-library'] });
  };

  const handleExportCsv = () => {
    const csv = serializeSafeCsv(
      clips.map((c) => ({
        id: c.id,
        title: c.title ?? '',
        platform: c.platform ?? '',
        duration: c.duration ?? 0,
        score: c.score ?? 0,
        rating: c.rating ?? 0,
        createdAt: c.createdAt ?? '',
      })),
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clipper-clips-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Safe CSV exported!');
    triggerCelebrationConfetti();
  };

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCollectionName.trim() }),
      });
      if (res.ok) {
        setNewCollectionName('');
        toast.success('Collection created!');
        await refetchCollections();
      }
    }, 'Creating clip collection…');
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    await withLoader(async () => {
      await fetch('/api/bridge/clips/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      toast.success(`Deleted ${selectedIds.length} clip(s).`);
      setSelectedIds([]);
      void queryClient.invalidateQueries({ queryKey: ['bridge-clips-library'] });
    }, 'Deleting selected clips…');
  };

  if (loadingClips) return <ClipsLoadingFallback />;

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Clips, Collections & Collaboration
            </h1>
            <p className="text-sm text-muted-foreground">
              Rate clips, organize into smart collections, create password-protected share links, chapters, and A/B tests.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedIds.length > 0 && (
              <Button variant="destructive" onClick={handleBulkDelete} className="rounded-[16px] font-bold gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete ({selectedIds.length})
              </Button>
            )}
            <Button variant="outline" onClick={handleExportCsv} className="rounded-[16px] font-bold gap-1.5">
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search titles, creators, tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 rounded-[16px] pl-10"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'all', label: 'All Active' },
              { id: 'top_rated', label: 'Top Rated ★' },
              { id: 'archived', label: 'Archived' },
            ].map((pill) => (
              <Button
                key={pill.id}
                size="sm"
                variant={collectionFilter === pill.id ? 'default' : 'outline'}
                onClick={() => setCollectionFilter(pill.id)}
                className="rounded-full font-bold text-xs"
              >
                {pill.label}
              </Button>
            ))}
            {(collectionsRes?.collections ?? []).map((col) => (
              <Badge
                key={col.id}
                variant="secondary"
                className="cursor-pointer rounded-full px-3 py-1 font-bold"
                onClick={() => setCollectionFilter(col.id)}
              >
                {col.name}
              </Badge>
            ))}
          </div>

          <div className="flex items-center gap-1.5 ml-auto">
            <Input
              placeholder="New collection…"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              className="h-9 w-40 rounded-[14px] text-xs"
            />
            <Button size="sm" variant="outline" onClick={handleCreateCollection} className="rounded-[14px]">
              <FolderPlus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {clips.length === 0 ? (
          <Card className="rounded-[24px] p-12 text-center text-sm text-muted-foreground">
            No matching clips found in this filter.
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clips.map((clip) => {
              const isChecked = selectedIds.includes(clip.id);
              return (
                <Card
                  key={clip.id}
                  className="rounded-[24px] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] transition flex flex-col justify-between overflow-hidden"
                >
                  <div className="p-5 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={(checked) =>
                            setSelectedIds((prev) =>
                              checked ? [...prev, clip.id] : prev.filter((x) => x !== clip.id),
                            )
                          }
                        />
                        <Badge variant="secondary" className="text-[10px] uppercase">
                          {clip.platform || 'Clip'}
                        </Badge>
                      </div>
                      <span className="text-xs font-extrabold text-[#FF8A30]">
                        {formatDuration(clip.duration)}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setActiveClip(clip)}
                      className="text-left block w-full group"
                    >
                      <h3 className="text-base font-extrabold truncate group-hover:text-primary transition">
                        {clip.title || clip.id}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {clip.streamer || 'Studio Creator'} · Score {clip.score ?? 80}
                      </p>
                    </button>

                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => void handleRate(clip.id, star)}
                          className="p-0.5 transition hover:scale-110"
                          aria-label={`Rate ${star} stars`}
                        >
                          <Star
                            className={cn(
                              'h-4 w-4',
                              (clip.rating ?? 0) >= star
                                ? 'fill-[#FFD43B] text-[#FFD43B]'
                                : 'text-muted-foreground/40',
                            )}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-border bg-muted/25 px-5 py-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs font-bold gap-1"
                      onClick={async () => {
                        await fetch(`/api/bridge/clips/${encodeURIComponent(clip.id)}/favorite`, { method: 'PATCH' });
                        void queryClient.invalidateQueries({ queryKey: ['bridge-clips-library'] });
                      }}
                    >
                      <Heart className={cn('h-3.5 w-3.5', clip.favorite && 'fill-[#FF5FA2] text-[#FF5FA2]')} />
                      Favorite
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-[12px] text-xs font-bold gap-1"
                      onClick={() => setActiveClip(clip)}
                    >
                      <Sparkles className="h-3.5 w-3.5 text-primary" /> Open Studio Tools
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {/* CLIP INSPECTOR DRAWER / SHEET */}
        <Sheet open={Boolean(activeClip)} onOpenChange={(o) => !o && setActiveClip(null)}>
          <SheetContent className="w-full sm:max-w-2xl overflow-y-auto" data-lenis-prevent>
            {activeClip && (
              <div className="space-y-5">
                <SheetHeader>
                  <SheetTitle className="text-xl font-extrabold">{activeClip.title || activeClip.id}</SheetTitle>
                  <SheetDescription>
                    Chapters, timestamped comments, expiring share links, A/B experiments, and exports.
                  </SheetDescription>
                </SheetHeader>

                <div className="overflow-hidden rounded-[18px] bg-black border border-border">
                  <video
                    src={`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/stream`}
                    controls
                    className="w-full max-h-72 object-contain"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-[12px] gap-1.5"
                    onClick={async () => {
                      await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/archive`, { method: 'PATCH' });
                      toast.success('Updated archive state.');
                      setActiveClip(null);
                      void queryClient.invalidateQueries({ queryKey: ['bridge-clips-library'] });
                    }}
                  >
                    <Archive className="h-3.5 w-3.5" /> Archive
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-[12px] gap-1.5"
                    asChild
                  >
                    <a href={`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/creator-kit`}>
                      <BookmarkCheck className="h-3.5 w-3.5 text-primary" /> Download Creator Kit
                    </a>
                  </Button>
                </div>

                <Tabs defaultValue="share">
                  <TabsList className="grid grid-cols-4 rounded-[14px]">
                    <TabsTrigger value="share">Shares</TabsTrigger>
                    <TabsTrigger value="chapters">Chapters</TabsTrigger>
                    <TabsTrigger value="comments">Comments</TabsTrigger>
                    <TabsTrigger value="ab">A/B Test</TabsTrigger>
                  </TabsList>

                  <TabsContent value="share" className="space-y-3 pt-3">
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder="Optional share password…"
                        value={sharePassword}
                        onChange={(e) => setSharePassword(e.target.value)}
                        className="rounded-[12px]"
                      />
                      <Button
                        onClick={async () => {
                          await withLoader(async () => {
                            const res = await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/shares`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ password: sharePassword || undefined, expiresHours: 72 }),
                            });
                            if (res.ok) {
                              setSharePassword('');
                              toast.success('Share link created!');
                              await refetchShares();
                            }
                          }, 'Minting share link…');
                        }}
                        className="rounded-[12px] gap-1.5 shrink-0 font-bold"
                      >
                        <Share2 className="h-4 w-4" /> Create Link
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {(sharesRes?.shares ?? []).map((s) => {
                        const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/share/${s.token}`;
                        return (
                          <div key={s.token} className="flex items-center justify-between gap-2 rounded-[12px] border border-border p-2.5 text-xs">
                            <span className="truncate font-mono">{url}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                void navigator.clipboard.writeText(url);
                                toast.success('Share URL copied!');
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </TabsContent>

                  <TabsContent value="chapters" className="space-y-3 pt-3">
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        className="w-20 rounded-[12px]"
                        value={chapterTime}
                        onChange={(e) => setChapterTime(e.target.value)}
                      />
                      <Input
                        placeholder="Chapter marker title…"
                        value={chapterTitle}
                        onChange={(e) => setChapterTitle(e.target.value)}
                        className="rounded-[12px]"
                      />
                      <Button
                        onClick={async () => {
                          if (!chapterTitle.trim()) return;
                          await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/chapters`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ title: chapterTitle.trim(), startSec: Number(chapterTime) || 0 }),
                          });
                          setChapterTitle('');
                          await refetchChapters();
                        }}
                        className="rounded-[12px]"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      {(chaptersRes?.chapters ?? []).map((ch) => (
                        <div key={ch.id} className="flex items-center justify-between rounded-[12px] bg-muted/45 px-3 py-2 text-xs">
                          <span><strong className="font-mono text-primary mr-2">{formatTimecode(ch.startSec)}</strong>{ch.title}</span>
                          <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                      ))}
                    </div>
                  </TabsContent>

                  <TabsContent value="comments" className="space-y-3 pt-3">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Leave frame note or feedback…"
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        className="rounded-[12px]"
                      />
                      <Button
                        onClick={async () => {
                          if (!commentText.trim()) return;
                          await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/comments`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ body: commentText.trim(), timestampSec: 0 }),
                          });
                          setCommentText('');
                          await refetchComments();
                        }}
                        className="rounded-[12px]"
                      >
                        <MessageSquare className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {(commentsRes?.comments ?? []).map((cm) => (
                        <div key={cm.id} className="rounded-[12px] border border-border p-3 text-xs space-y-1">
                          <div className="flex justify-between font-bold">
                            <span>{cm.author || 'Reviewer'}</span>
                            <span className="text-muted-foreground">{formatTimecode(cm.timestampSec)}</span>
                          </div>
                          <p>{cm.body}</p>
                        </div>
                      ))}
                    </div>
                  </TabsContent>

                  <TabsContent value="ab" className="space-y-3 pt-3">
                    <div className="grid gap-2">
                      <Label className="text-xs">Title Variant A & B</Label>
                      <Input placeholder="Hook A" value={abTitleA} onChange={(e) => setAbTitleA(e.target.value)} className="rounded-[12px]" />
                      <Input placeholder="Hook B" value={abTitleB} onChange={(e) => setAbTitleB(e.target.value)} className="rounded-[12px]" />
                      <Button
                        onClick={async () => {
                          if (!abTitleA.trim() || !abTitleB.trim()) return;
                          await fetch(`/api/bridge/clips/${encodeURIComponent(activeClip.id)}/ab-tests`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ variantA: abTitleA.trim(), variantB: abTitleB.trim() }),
                          });
                          setAbTitleA('');
                          setAbTitleB('');
                          await refetchAb();
                        }}
                        className="rounded-[12px] font-bold gap-1.5"
                      >
                        <FlaskConical className="h-4 w-4" /> Start Title Experiment
                      </Button>
                    </div>
                    {(abRes?.experiments ?? []).map((exp) => (
                      <div key={exp.id} className="rounded-[12px] border border-border p-3 text-xs space-y-1">
                        <p><strong>A:</strong> {exp.variantA}</p>
                        <p><strong>B:</strong> {exp.variantB}</p>
                        <p className="text-primary font-bold">Winner: {exp.winner || 'Gathering data'}</p>
                      </div>
                    ))}
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </PageTransition>
  );
}
