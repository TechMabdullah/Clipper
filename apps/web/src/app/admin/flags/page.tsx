'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Flag, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

interface FlagItem {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPct: number;
  targetRoles: string[];
  updatedBy?: string;
}

export default function AdminFlagsPage() {
  const [reason, setReason] = React.useState('Feature rollout adjustment');
  const [newKey, setNewKey] = React.useState('');
  const [newDesc, setNewDesc] = React.useState('');

  const { data, isLoading, refetch } = useQuery<{ flags: FlagItem[] }>({
    queryKey: ['admin-feature-flags'],
    queryFn: async () => {
      const res = await fetch('/api/admin/flags', { cache: 'no-store' });
      return res.ok ? res.json() : { flags: [] };
    },
  });

  const handleSaveFlag = async (flag: FlagItem) => {
    if (reason.trim().length < 3) {
      toast.error('Provide a rollout reason (min 3 chars).');
      return;
    }
    await withLoader(async () => {
      const res = await fetch('/api/admin/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...flag, reason }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Could not update flag.');
        return;
      }
      toast.success(`Updated flag "${flag.key}" (${flag.rolloutPct}%).`);
      await refetch();
    }, `Updating flag ${flag.key}…`);
  };

  return (
    <PageTransition>
      <div className="space-y-6 max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Feature Flags & Rollouts</h1>
            <p className="text-sm text-muted-foreground">
              Percentage-bucketed toggles with role targeting and mandatory audit reasoning.
            </p>
          </div>
          <div className="w-72">
            <Input
              placeholder="Audit reason for changes…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="rounded-[12px] text-xs"
            />
          </div>
        </div>

        <Card className="rounded-[20px] p-5 grid gap-3 sm:grid-cols-3">
          <Input placeholder="flag_key_snake_case" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="rounded-[12px] font-mono text-xs" />
          <Input placeholder="Description…" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} className="rounded-[12px] text-xs" />
          <Button
            onClick={() =>
              void handleSaveFlag({
                key: newKey.trim(),
                description: newDesc.trim(),
                enabled: true,
                rolloutPct: 100,
                targetRoles: ['customer', 'support', 'admin', 'superadmin'],
              })
            }
            className="rounded-[12px] font-bold gap-1.5"
          >
            <Flag className="h-4 w-4" /> Create Flag
          </Button>
        </Card>

        <MinReveal ready={!isLoading} fallback={<SkeletonList items={4} />}>
          <div className="space-y-3">
            {(data?.flags ?? []).map((f) => (
              <FlagRowCard key={f.key} flag={f} onSave={handleSaveFlag} />
            ))}
          </div>
        </MinReveal>
      </div>
    </PageTransition>
  );
}

function FlagRowCard({
  flag,
  onSave,
}: {
  flag: FlagItem;
  onSave: (next: FlagItem) => Promise<void>;
}) {
  const [enabled, setEnabled] = React.useState(flag.enabled);
  const [rolloutPct, setRolloutPct] = React.useState(flag.rolloutPct);

  return (
    <Card className="rounded-[20px] p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="space-y-1 max-w-md">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-extrabold">{flag.key}</span>
          <Badge variant={enabled ? 'default' : 'secondary'}>{rolloutPct}%</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{flag.description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-xs">Rollout %</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={rolloutPct}
            onChange={(e) => setRolloutPct(Number(e.target.value) || 0)}
            className="w-20 h-8 rounded-[10px] text-xs"
          />
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onSave({ ...flag, enabled, rolloutPct })}
          className="rounded-[10px] text-xs font-bold gap-1"
        >
          <Save className="h-3.5 w-3.5" /> Save
        </Button>
      </div>
    </Card>
  );
}
