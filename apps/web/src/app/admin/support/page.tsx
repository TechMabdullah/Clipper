'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

interface AdminTicket {
  id: string;
  email: string;
  subject: string;
  priority: string;
  status: string;
  slaDueAt?: number;
  messages: Array<{ id: string; senderName: string; senderRole: string; body: string }>;
}

const CANNED_REPLIES = [
  'Hi there! Could you share the diagnostic report bundle from Settings so we can inspect FFmpeg/OpenCV output?',
  'Your Stripe billing entitlement has been refreshed — please reload /billing to sync quota limits.',
  'We have escalated this issue to engineering and will update this thread shortly.',
];

export default function AdminSupportInboxPage() {
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [selected, setSelected] = React.useState<AdminTicket | null>(null);
  const [replyText, setReplyText] = React.useState('');
  const [mergeId, setMergeId] = React.useState('');

  const { data, isLoading, refetch } = useQuery<{ tickets: AdminTicket[] }>({
    queryKey: ['admin-support-inbox', statusFilter],
    queryFn: async () => {
      const qs = statusFilter !== 'all' ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const res = await fetch(`/api/admin/support${qs}`, { cache: 'no-store' });
      return res.ok ? res.json() : { tickets: [] };
    },
  });

  const handleAgentUpdate = async (patch: { status?: string; replyMessage?: string; mergeIntoTicketId?: string }) => {
    if (!selected) return;
    await withLoader(async () => {
      const res = await fetch('/api/admin/support', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: selected.id, ...patch }),
      });
      if (!res.ok) {
        toast.error('Failed to update ticket.');
        return;
      }
      setReplyText('');
      setMergeId('');
      toast.success('Support thread updated!');
      await refetch();
    }, 'Updating support conversation…');
  };

  const tickets = data?.tickets ?? [];

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Support SLA Inbox</h1>
            <p className="text-sm text-muted-foreground">
              Triage creator issues with canned replies, SLA priority timers, and thread merging.
            </p>
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44 rounded-[14px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tickets</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonList items={5} />}>
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-5 space-y-2.5">
              {tickets.length === 0 ? (
                <Card className="rounded-[20px] p-8 text-center text-xs text-muted-foreground">
                  Inbox zero — no support tickets found.
                </Card>
              ) : (
                tickets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelected(t)}
                    className={`w-full rounded-[18px] border p-4 text-left transition ${
                      selected?.id === t.id ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted/30'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="secondary" className="text-[10px] uppercase">{t.priority}</Badge>
                      <Badge variant="outline" className="text-[10px]">{t.status}</Badge>
                    </div>
                    <p className="mt-1.5 text-sm font-extrabold truncate">{t.subject}</p>
                    <p className="text-xs text-muted-foreground truncate">{t.email}</p>
                  </button>
                ))
              )}
            </div>

            <div className="lg:col-span-7">
              {selected ? (
                <Card className="rounded-[22px] p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                    <div>
                      <h2 className="text-base font-extrabold">{selected.subject}</h2>
                      <p className="text-xs text-muted-foreground">{selected.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {selected.slaDueAt && (
                        <Badge variant="outline" className="text-[10px] gap-1">
                          <Clock className="h-3 w-3 text-[#FF8A30]" />
                          SLA {new Date(selected.slaDueAt).toLocaleTimeString()}
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleAgentUpdate({ status: 'resolved' })}
                        className="rounded-[10px] text-xs font-bold"
                      >
                        Mark Resolved
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {(selected.messages ?? []).map((m) => (
                      <div key={m.id} className="rounded-[14px] bg-muted/45 p-3 text-xs space-y-1">
                        <p className="font-bold">
                          {m.senderName} <span className="text-[10px] uppercase text-primary">({m.senderRole})</span>
                        </p>
                        <p>{m.body}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {CANNED_REPLIES.map((cr, idx) => (
                        <Button
                          key={idx}
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setReplyText(cr)}
                          className="h-7 rounded-full text-[11px] gap-1"
                        >
                          <Sparkles className="h-3 w-3 text-primary" /> Canned #{idx + 1}
                        </Button>
                      ))}
                    </div>
                    <Textarea
                      rows={3}
                      placeholder="Write support reply…"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      className="rounded-[14px]"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex gap-2">
                        <Input
                          placeholder="Merge into ticket ID…"
                          value={mergeId}
                          onChange={(e) => setMergeId(e.target.value)}
                          className="h-9 w-40 rounded-[12px] text-xs"
                        />
                        {mergeId.trim() && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleAgentUpdate({ mergeIntoTicketId: mergeId.trim() })}
                            className="rounded-[12px] text-xs"
                          >
                            Merge
                          </Button>
                        )}
                      </div>
                      <Button
                        onClick={() => void handleAgentUpdate({ status: 'in_progress', replyMessage: replyText })}
                        className="rounded-[12px] font-bold gap-1.5"
                      >
                        <Send className="h-3.5 w-3.5" /> Send Reply
                      </Button>
                    </div>
                  </div>
                </Card>
              ) : (
                <Card className="rounded-[22px] p-12 text-center text-sm text-muted-foreground">
                  Select a ticket on the left to inspect thread history and reply.
                </Card>
              )}
            </div>
          </div>
        </MinReveal>
      </div>
    </PageTransition>
  );
}
