'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageTransition } from '@/components/motion/page-transition';
import { withLoader } from '@/stores/loader-store';

export default function AdminSettingsPage() {
  // TOTP enrollment state
  const [totpSecret, setTotpSecret] = React.useState('');
  const [totpUri, setTotpUri] = React.useState('');
  const [totpConfirmCode, setTotpConfirmCode] = React.useState('');

  // Maintenance state
  const [maintEnabled, setMaintEnabled] = React.useState(false);
  const [maintMsg, setMaintMsg] = React.useState('');
  const [maintReason, setMaintReason] = React.useState('Planned maintenance window');

  // API key creation
  const [newKeyName, setNewKeyName] = React.useState('');
  const [createdKeyToken, setCreatedKeyToken] = React.useState('');

  const { data: totpStatus, refetch: refetchTotp } = useQuery<{
    enabled: boolean;
    verifiedThisSession: boolean;
  }>({
    queryKey: ['admin-totp-status'],
    queryFn: async () => {
      const res = await fetch('/api/auth/totp', { cache: 'no-store' });
      return res.ok ? res.json() : { enabled: false, verifiedThisSession: false };
    },
  });

  const { data: rbacData } = useQuery<{
    roles?: Record<string, string[]>;
    canEditRoles?: boolean;
  }>({
    queryKey: ['admin-rbac-matrix'],
    queryFn: async () => {
      const res = await fetch('/api/admin/roles', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  const { data: maintData } = useQuery<{ enabled: boolean; message: string }>({
    queryKey: ['admin-maintenance'],
    queryFn: async () => {
      const res = await fetch('/api/admin/maintenance', { cache: 'no-store' });
      return res.ok ? res.json() : { enabled: false, message: '' };
    },
  });

  const { data: apiKeysData, refetch: refetchKeys } = useQuery<{
    keys?: Array<{ id: string; name: string; prefix?: string }>;
  }>({
    queryKey: ['bridge-admin-api-keys'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/admin/api-keys', { cache: 'no-store' });
      return res.ok ? res.json() : { keys: [] };
    },
  });

  const { data: secScan, refetch: runSecScan } = useQuery<{
    score?: number;
    checks?: Array<{ id: string; ok: boolean; detail: string }>;
  }>({
    queryKey: ['bridge-admin-sec-scan'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/admin/security-scan', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  const { data: updateCheck, refetch: checkUpdates } = useQuery<{
    hasUpdates?: boolean;
    currentSha?: string;
    remoteSha?: string;
    behindCount?: number;
  }>({
    queryKey: ['bridge-system-update-check'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/system/update/check', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  React.useEffect(() => {
    if (maintData) {
      setMaintEnabled(maintData.enabled);
      setMaintMsg(maintData.message);
    }
  }, [maintData]);

  const handleStartTotpEnroll = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enroll_start' }),
      });
      const json = await res.json();
      if (res.ok) {
        setTotpSecret(json.secret);
        setTotpUri(json.otpauthUri);
        toast.info('Add this secret to Google Authenticator / 1Password, then confirm code.');
      }
    }, 'Generating TOTP enrollment key…');
  };

  const handleConfirmTotpEnroll = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enroll_confirm', code: totpConfirmCode }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Invalid TOTP code.');
        return;
      }
      setTotpSecret('');
      setTotpUri('');
      setTotpConfirmCode('');
      toast.success('Admin TOTP 2FA enabled & verified!');
      await refetchTotp();
    }, 'Confirming TOTP 2FA…');
  };

  const handleSaveMaintenance = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/admin/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: maintEnabled, message: maintMsg, reason: maintReason }),
      });
      if (res.ok) {
        toast.success('Maintenance state saved & audited!');
      } else {
        toast.error('Only admin/superadmin can modify maintenance mode.');
      }
    }, 'Updating maintenance banner…');
  };

  return (
    <PageTransition>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Admin Settings, Security & System Maintenance
          </h1>
          <p className="text-sm text-muted-foreground">
            TOTP 2FA enforcement, RBAC permission matrix, API keys, security scan, maintenance banner, and tool upgrades.
          </p>
        </div>

        <Tabs defaultValue="security" className="space-y-5">
          <TabsList className="rounded-[14px]">
            <TabsTrigger value="security">2FA & RBAC</TabsTrigger>
            <TabsTrigger value="keys">API Keys & Engine</TabsTrigger>
            <TabsTrigger value="system">System & Updates</TabsTrigger>
          </TabsList>

          <TabsContent value="security" className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[22px] p-6 space-y-4">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="flex items-center justify-between text-base font-extrabold">
                  <span className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" /> Admin Authenticator TOTP
                  </span>
                  <Badge variant={totpStatus?.enabled ? 'default' : 'secondary'}>
                    {totpStatus?.enabled ? 'Enabled' : 'Not Enrolled'}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Optional/enforced second-factor authenticator check before destructive admin actions.
                </CardDescription>
              </CardHeader>

              {!totpStatus?.enabled && !totpSecret && (
                <Button onClick={handleStartTotpEnroll} className="rounded-[12px] font-bold">
                  Begin TOTP 2FA Enrollment
                </Button>
              )}

              {totpSecret && (
                <div className="space-y-3 rounded-[16px] border border-border bg-muted/35 p-4 text-xs">
                  <p className="font-bold">Manual Secret Key:</p>
                  <p className="font-mono text-sm font-extrabold text-primary break-all">{totpSecret}</p>
                  <p className="font-mono text-[11px] break-all text-muted-foreground">{totpUri}</p>
                  <div className="flex gap-2 pt-2">
                    <Input
                      placeholder="6-digit code…"
                      maxLength={6}
                      value={totpConfirmCode}
                      onChange={(e) => setTotpConfirmCode(e.target.value)}
                      className="rounded-[12px] font-mono"
                    />
                    <Button onClick={handleConfirmTotpEnroll} className="rounded-[12px] font-bold">
                      Activate
                    </Button>
                  </div>
                </div>
              )}
            </Card>

            <Card className="rounded-[22px] p-6 space-y-4">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="text-base font-extrabold">RBAC Permission Matrix</CardTitle>
                <CardDescription>
                  {rbacData?.canEditRoles
                    ? 'You are signed in as superadmin and can modify user roles.'
                    : 'Read-only view (superadmin required to change roles).'}
                </CardDescription>
              </CardHeader>
              <div className="space-y-2.5 text-xs">
                {Object.entries(rbacData?.roles ?? {}).map(([roleName, perms]) => (
                  <div key={roleName} className="rounded-[14px] border border-border p-3">
                    <p className="font-extrabold uppercase text-primary">{roleName}</p>
                    <p className="mt-1 text-muted-foreground leading-relaxed">{perms.join(' · ')}</p>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="keys" className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[22px] p-6 space-y-4">
              <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                <KeyRound className="h-4 w-4 text-[#FF8A30]" /> Clipper Engine API Keys (`csk_*`)
              </CardTitle>
              <div className="flex gap-2">
                <Input
                  placeholder="Key label (e.g. CI Runner)…"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="rounded-[12px]"
                />
                <Button
                  onClick={async () => {
                    if (!newKeyName.trim()) return;
                    const res = await fetch('/api/bridge/admin/api-keys', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: newKeyName.trim() }),
                    });
                    const j = await res.json();
                    if (res.ok && j.key) {
                      setCreatedKeyToken(j.key);
                      setNewKeyName('');
                      await refetchKeys();
                    }
                  }}
                  className="rounded-[12px] font-bold"
                >
                  Mint Key
                </Button>
              </div>
              {createdKeyToken && (
                <p className="rounded-[12px] bg-emerald-500/10 p-3 font-mono text-xs text-emerald-700 dark:text-emerald-300 break-all">
                  Save now (shown once): {createdKeyToken}
                </p>
              )}
              <div className="space-y-2">
                {(apiKeysData?.keys ?? []).map((k) => (
                  <div key={k.id} className="flex justify-between rounded-[12px] border border-border px-3 py-2 text-xs">
                    <span className="font-bold">{k.name}</span>
                    <span className="font-mono text-muted-foreground">{k.prefix || 'csk_***'}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="rounded-[22px] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                  <Terminal className="h-4 w-4 text-primary" /> Local Security Self-Audit
                </CardTitle>
                <Button size="sm" variant="outline" onClick={() => void runSecScan()} className="rounded-[10px]">
                  Re-Scan
                </Button>
              </div>
              <div className="space-y-2 text-xs">
                {(secScan?.checks ?? []).map((chk) => (
                  <div key={chk.id} className="flex items-center justify-between rounded-[12px] border border-border px-3 py-2">
                    <span>{chk.detail}</span>
                    <Badge variant={chk.ok ? 'default' : 'destructive'}>{chk.ok ? 'PASS' : 'WARN'}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="system" className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[22px] p-6 space-y-4">
              <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                <AlertTriangle className="h-4 w-4 text-[#FFD43B]" /> Global Maintenance Banner
              </CardTitle>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold">Enable Maintenance Banner</span>
                <Switch checked={maintEnabled} onCheckedChange={setMaintEnabled} />
              </div>
              <Input
                placeholder="Maintenance notice shown across customer dashboard…"
                value={maintMsg}
                onChange={(e) => setMaintMsg(e.target.value)}
                className="rounded-[12px]"
              />
              <Input
                placeholder="Audit reason…"
                value={maintReason}
                onChange={(e) => setMaintReason(e.target.value)}
                className="rounded-[12px] text-xs"
              />
              <Button onClick={handleSaveMaintenance} className="rounded-[12px] font-bold">
                Save Maintenance State
              </Button>
            </Card>

            <Card className="rounded-[22px] p-6 space-y-4">
              <CardTitle className="flex items-center gap-2 text-base font-extrabold">
                <Wrench className="h-4 w-4 text-primary" /> Tool & Repo Updater (`update.ps1` / `update.sh`)
              </CardTitle>
              <div className="rounded-[14px] bg-muted/45 p-4 text-xs space-y-1">
                <p>Current SHA: <strong className="font-mono">{updateCheck?.currentSha || 'unknown'}</strong></p>
                <p>Remote SHA: <strong className="font-mono">{updateCheck?.remoteSha || 'unknown'}</strong></p>
                <p>Status: <strong>{updateCheck?.hasUpdates ? `${updateCheck.behindCount ?? 1} update(s) available` : 'Up to date'}</strong></p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void checkUpdates()} className="rounded-[12px] gap-1.5 text-xs font-bold">
                  <RefreshCw className="h-3.5 w-3.5" /> Check for Updates
                </Button>
                <Button
                  onClick={() =>
                    withLoader(async () => {
                      const res = await fetch('/api/bridge/system/upgrade', { method: 'POST' });
                      const j = await res.json();
                      if (res.ok) {
                        toast.success(j.message || 'Tool upgrade completed!');
                      } else {
                        toast.error(j.error || 'Upgrade failed.');
                      }
                    }, 'Running git pull & dependency upgrade…')
                  }
                  className="rounded-[12px] font-bold text-xs"
                >
                  Run One-Click Upgrade
                </Button>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
