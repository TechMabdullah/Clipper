'use client';

import * as React from 'react';
import { useDropzone } from 'react-dropzone';
import { useQuery } from '@tanstack/react-query';
import { HelpCircle, MessageSquarePlus, Paperclip, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

interface SupportTicket {
  id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  messages: Array<{ id: string; senderName: string; senderRole: string; body: string; createdAt: number }>;
}

export default function SupportPage() {
  const [subject, setSubject] = React.useState('');
  const [category, setCategory] = React.useState('clipper');
  const [priority, setPriority] = React.useState('normal');
  const [message, setMessage] = React.useState('');
  const [files, setFiles] = React.useState<File[]>([]);
  const [replyMap, setReplyMap] = React.useState<Record<string, string>>({});

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    maxFiles: 4,
    onDrop: (accepted) => setFiles((prev) => [...prev, ...accepted].slice(0, 4)),
  });

  const { data: ticketsRes, isLoading, refetch } = useQuery<{ tickets: SupportTicket[] }>({
    queryKey: ['customer-support-tickets'],
    queryFn: async () => {
      const res = await fetch('/api/customer/support', { cache: 'no-store' });
      return res.ok ? res.json() : { tickets: [] };
    },
  });

  const { data: publicCtx } = useQuery<{ faqs: Array<{ id: string; question: string; answer: string }> }>({
    queryKey: ['public-context-faq'],
    queryFn: async () => {
      const res = await fetch('/api/public/context', { cache: 'no-store' });
      return res.ok ? res.json() : { faqs: [] };
    },
  });

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/customer/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: subject.trim(),
          category,
          priority,
          message: message.trim(),
          attachmentNames: files.map((f) => f.name),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Could not submit support ticket.');
        return;
      }
      setSubject('');
      setMessage('');
      setFiles([]);
      toast.success('Support ticket opened! Our team is reviewing it.');
      await refetch();
    }, 'Submitting support ticket…');
  };

  const handleReply = async (ticketId: string) => {
    const text = (replyMap[ticketId] ?? '').trim();
    if (!text) return;
    await withLoader(async () => {
      const res = await fetch('/api/customer/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, message: text }),
      });
      if (res.ok) {
        setReplyMap((p) => ({ ...p, [ticketId]: '' }));
        toast.success('Reply sent.');
        await refetch();
      }
    }, 'Sending reply…');
  };

  return (
    <PageTransition>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Support & Help Center</h1>
          <p className="text-sm text-muted-foreground">
            Open a support conversation with log attachments or browse quick troubleshooting FAQs.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-12">
          <Card className="rounded-[24px] lg:col-span-5 shadow-[var(--shadow-sm)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg font-extrabold">
                <MessageSquarePlus className="h-5 w-5 text-primary" /> Open New Ticket
              </CardTitle>
              <CardDescription>Typical response SLA under 12 hours.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateTicket} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Subject</Label>
                  <Input
                    required
                    placeholder="e.g. Facecam box misaligned on vertical export"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="rounded-[14px]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Category</Label>
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="clipper">Clipper Engine</SelectItem>
                        <SelectItem value="billing">Billing</SelectItem>
                        <SelectItem value="account">Account & OTP</SelectItem>
                        <SelectItem value="bug">Bug Report</SelectItem>
                        <SelectItem value="feature">Feature Request</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Priority</Label>
                    <Select value={priority} onValueChange={setPriority}>
                      <SelectTrigger className="rounded-[14px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="urgent">Urgent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Details</Label>
                  <Textarea
                    required
                    rows={4}
                    placeholder="Describe what happened and steps to reproduce…"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className="rounded-[16px]"
                  />
                </div>
                <div
                  {...getRootProps()}
                  className="cursor-pointer rounded-[16px] border border-dashed border-border p-4 text-center text-xs text-muted-foreground hover:border-primary/50 transition"
                >
                  <input {...getInputProps()} />
                  <Paperclip className="mx-auto mb-1 h-4 w-4 text-primary" />
                  {isDragActive
                    ? 'Drop screenshots or log files here…'
                    : 'Drag & drop screenshots or logs (up to 4 files)'}
                  {files.length > 0 && (
                    <p className="mt-2 font-bold text-foreground">
                      Attached: {files.map((f) => f.name).join(', ')}
                    </p>
                  )}
                </div>
                <Button type="submit" className="w-full h-11 rounded-[16px] font-bold">
                  Submit Ticket
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="lg:col-span-7 space-y-6">
            <MinReveal ready={!isLoading} fallback={<SkeletonList items={4} />}>
              <div className="space-y-4">
                <h2 className="text-lg font-extrabold">Your Support Threads</h2>
                {(ticketsRes?.tickets ?? []).length === 0 ? (
                  <Card className="rounded-[22px] p-8 text-center text-sm text-muted-foreground">
                    No support tickets opened yet.
                  </Card>
                ) : (
                  (ticketsRes?.tickets ?? []).map((t) => (
                    <Card key={t.id} className="rounded-[22px] p-5 space-y-4 shadow-[var(--shadow-sm)]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-extrabold">{t.subject}</h3>
                          <p className="text-xs text-muted-foreground uppercase">
                            {t.category} · Priority {t.priority}
                          </p>
                        </div>
                        <Badge>{t.status}</Badge>
                      </div>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {(t.messages ?? []).map((m) => (
                          <div key={m.id} className="rounded-[14px] bg-muted/45 p-3 text-xs space-y-1">
                            <p className="font-bold">
                              {m.senderName}{' '}
                              <span className="text-[10px] uppercase text-primary">({m.senderRole})</span>
                            </p>
                            <p>{m.body}</p>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Write a follow-up reply…"
                          value={replyMap[t.id] ?? ''}
                          onChange={(e) => setReplyMap((p) => ({ ...p, [t.id]: e.target.value }))}
                          className="rounded-[14px] text-xs"
                        />
                        <Button size="sm" onClick={() => void handleReply(t.id)} className="rounded-[14px]">
                          <Send className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            </MinReveal>

            <Card className="rounded-[24px] p-5 shadow-[var(--shadow-sm)]">
              <CardTitle className="flex items-center gap-2 text-base font-extrabold mb-3">
                <HelpCircle className="h-4 w-4 text-primary" /> Frequently Asked Questions
              </CardTitle>
              <Accordion type="single" collapsible>
                {(publicCtx?.faqs && publicCtx.faqs.length > 0
                  ? publicCtx.faqs
                  : [
                      {
                        id: 'faq-1',
                        question: 'How does Firebase + Resend OTP post-login verification work?',
                        answer:
                          'After signing in with Google or Email/Password, Clipper Studio emails a one-time 6-digit HMAC-signed OTP valid for 5 minutes before minting an httpOnly server session cookie.',
                      },
                      {
                        id: 'faq-2',
                        question: 'Why does Studio say Engine Offline (:4001)?',
                        answer:
                          'Heavy FFmpeg, OpenCV BlazeFace, and yt-dlp tasks run in apps/clipper-service on port 4001. Run pnpm dev or ./start-clipper.ps1 to keep both :3000 and :4001 running.',
                      },
                    ]
                ).map((faq) => (
                  <AccordionItem key={faq.id} value={faq.id}>
                    <AccordionTrigger className="text-left text-xs font-bold">{faq.question}</AccordionTrigger>
                    <AccordionContent className="text-xs text-muted-foreground">{faq.answer}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </Card>
          </div>
        </div>
      </div>
    </PageTransition>
  );
}
