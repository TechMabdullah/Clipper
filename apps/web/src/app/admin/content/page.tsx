'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Mail, Megaphone, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

export default function AdminContentPage() {
  const [annTitle, setAnnTitle] = React.useState('');
  const [annBody, setAnnBody] = React.useState('');
  const [annTone, setAnnTone] = React.useState<'info' | 'promo' | 'warning'>('info');

  const [faqQuestion, setFaqQuestion] = React.useState('');
  const [faqAnswer, setFaqAnswer] = React.useState('');

  const { data, isLoading, refetch } = useQuery<{
    announcements: Array<{ id: string; title: string; body: string; tone?: string; active?: boolean }>;
    faqs: Array<{ id: string; question: string; answer: string }>;
  }>({
    queryKey: ['admin-content'],
    queryFn: async () => {
      const res = await fetch('/api/admin/content', { cache: 'no-store' });
      return res.ok ? res.json() : { announcements: [], faqs: [] };
    },
  });

  const handleSaveAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    await withLoader(async () => {
      const res = await fetch('/api/admin/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'announcement',
          title: annTitle,
          body: annBody,
          tone: annTone,
          active: true,
        }),
      });
      if (!res.ok) {
        toast.error('Failed to publish announcement.');
        return;
      }
      setAnnTitle('');
      setAnnBody('');
      toast.success('Announcement published globally!');
      await refetch();
    }, 'Publishing announcement banner…');
  };

  const handleSaveFaq = async (e: React.FormEvent) => {
    e.preventDefault();
    await withLoader(async () => {
      const res = await fetch('/api/admin/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'faq',
          question: faqQuestion,
          answer: faqAnswer,
        }),
      });
      if (!res.ok) {
        toast.error('Failed to save FAQ item.');
        return;
      }
      setFaqQuestion('');
      setFaqAnswer('');
      toast.success('FAQ item added!');
      await refetch();
    }, 'Saving FAQ entry…');
  };

  const handleDelete = async (collection: 'announcements' | 'faq_items', id: string) => {
    await withLoader(async () => {
      await fetch('/api/admin/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'delete', collection, id }),
      });
      await refetch();
      toast.success('Item deleted.');
    }, 'Removing content item…');
  };

  return (
    <PageTransition>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Content, Banners & Email Templates</h1>
          <p className="text-sm text-muted-foreground">
            Publish global announcement bars, maintain help center FAQs, and preview React Email layouts.
          </p>
        </div>

        <Tabs defaultValue="announcements" className="space-y-5">
          <TabsList className="rounded-[14px]">
            <TabsTrigger value="announcements">Announcements</TabsTrigger>
            <TabsTrigger value="faq">Help Center FAQ</TabsTrigger>
            <TabsTrigger value="emails">Email Templates</TabsTrigger>
          </TabsList>

          <TabsContent value="announcements" className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[22px] p-6">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <Megaphone className="h-4 w-4 text-primary" /> New Banner Announcement
                </CardTitle>
              </CardHeader>
              <form onSubmit={handleSaveAnnouncement} className="space-y-3">
                <Input
                  required
                  placeholder="Headline…"
                  value={annTitle}
                  onChange={(e) => setAnnTitle(e.target.value)}
                  className="rounded-[12px]"
                />
                <Textarea
                  required
                  placeholder="Banner copy shown at the top of the app…"
                  value={annBody}
                  onChange={(e) => setAnnBody(e.target.value)}
                  className="rounded-[12px]"
                />
                <Select value={annTone} onValueChange={(v) => setAnnTone(v as 'info' | 'promo' | 'warning')}>
                  <SelectTrigger className="rounded-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">Info (Primary)</SelectItem>
                    <SelectItem value="promo">Promo (Gradient)</SelectItem>
                    <SelectItem value="warning">Warning (Amber)</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="submit" className="w-full rounded-[12px] font-bold gap-1.5">
                  <Plus className="h-4 w-4" /> Publish Announcement
                </Button>
              </form>
            </Card>

            <MinReveal ready={!isLoading} fallback={<SkeletonList items={3} />}>
              <div className="space-y-3">
                {(data?.announcements ?? []).map((a) => (
                  <Card key={a.id} className="rounded-[18px] p-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px] uppercase">{a.tone || 'info'}</Badge>
                        <span className="text-sm font-extrabold">{a.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{a.body}</p>
                    </div>
                    <Button size="icon" variant="ghost" className="text-destructive" onClick={() => void handleDelete('announcements', a.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Card>
                ))}
              </div>
            </MinReveal>
          </TabsContent>

          <TabsContent value="faq" className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[22px] p-6">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <FileText className="h-4 w-4 text-[#FF8A30]" /> Add Support FAQ
                </CardTitle>
              </CardHeader>
              <form onSubmit={handleSaveFaq} className="space-y-3">
                <Label className="text-xs">Question</Label>
                <Input required value={faqQuestion} onChange={(e) => setFaqQuestion(e.target.value)} className="rounded-[12px]" />
                <Label className="text-xs">Answer</Label>
                <Textarea required rows={4} value={faqAnswer} onChange={(e) => setFaqAnswer(e.target.value)} className="rounded-[12px]" />
                <Button type="submit" className="w-full rounded-[12px] font-bold">Add FAQ Item</Button>
              </form>
            </Card>

            <div className="space-y-3">
              {(data?.faqs ?? []).map((f) => (
                <Card key={f.id} className="rounded-[18px] p-4 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-extrabold">{f.question}</p>
                    <p className="text-xs text-muted-foreground mt-1">{f.answer}</p>
                  </div>
                  <Button size="icon" variant="ghost" className="text-destructive" onClick={() => void handleDelete('faq_items', f.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="emails">
            <Card className="rounded-[24px] p-6 space-y-4">
              <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                <Mail className="h-4 w-4 text-primary" /> Resend React Email Verification Preview
              </CardTitle>
              <CardDescription>
                Rendered from <code className="font-mono">src/emails/otp-verification.tsx</code>.
              </CardDescription>
              <div className="mx-auto max-w-md rounded-[24px] border border-border bg-[#F7F6FB] p-6 text-[#1A1A2E]">
                <div className="rounded-[20px] border border-[#E6E8F5] bg-white p-6 space-y-3">
                  <p className="text-base font-extrabold text-[#6C63FF]">✂ Clipper Studio</p>
                  <h3 className="text-xl font-extrabold">Verify your sign-in</h3>
                  <p className="text-xs text-[#646782]">
                    Enter this 6-digit verification code to complete your Clipper Studio sign-in. It expires in 5 minutes.
                  </p>
                  <div className="rounded-[14px] border border-dashed border-[#6C63FF] bg-[#F2F0FF] p-4 text-center font-mono text-2xl font-extrabold tracking-[0.35em] text-[#1A1A2E]">
                    482915
                  </div>
                </div>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
