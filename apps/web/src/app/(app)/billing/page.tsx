'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Check, CreditCard, ExternalLink, KeyRound, ShieldAlert, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MotionCard } from '@/components/ui/motion-card';
import { triggerCelebrationConfetti } from '@/lib/confetti';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonCard } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

interface PlanInfo {
  id: string;
  name: string;
  tagline?: string;
  price_usd?: number;
  priceMonthly?: number;
  priceLabel?: string;
  features?: string[];
  daily_clip_limit?: number;
  maxClipsPerDay?: number;
  allow_auto_captions?: number;
  allow_audio_peak?: number;
  allow_watchlist?: number;
}

function BillingPageContent() {
  const params = useSearchParams();
  const [licenseKey, setLicenseKey] = React.useState('');

  const { data: statusData, isLoading: loadingStatus, refetch: refetchStatus } = useQuery<{
    entitlement?: {
      plan?: PlanInfo;
      license?: { maskedKey?: string; provider?: string; customer_email?: string };
      usage?: { usedToday?: number; dailyLimit?: number; unlimited?: boolean };
      stripeConfigured?: boolean;
      portalUrl?: string;
    };
    plans?: PlanInfo[];
  }>({
    queryKey: ['bridge-billing-status'],
    queryFn: async () => {
      const res = await fetch('/api/bridge/billing/status', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  // Auto-activate Stripe checkout session if redirected back from Stripe with ?session_id=cs_...
  React.useEffect(() => {
    const checkout = params?.get('checkout');
    const sid = params?.get('session_id');
    if (checkout === 'success' && sid && sid.startsWith('cs_')) {
      void withLoader(async () => {
        const res = await fetch('/api/bridge/billing/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: sid }),
        });
        if (res.ok) {
          toast.success('Stripe Checkout verified! Plan unlocked.');
          triggerCelebrationConfetti();
          await refetchStatus();
        }
      }, 'Confirming Stripe Checkout payment…');
    } else if (checkout === 'cancelled') {
      toast.info('Stripe Checkout was cancelled.');
    }
  }, [params, refetchStatus]);

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseKey.trim()) return;
    await withLoader(async () => {
      const res = await fetch('/api/bridge/billing/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: licenseKey.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Activation failed.');
        return;
      }
      setLicenseKey('');
      toast.success('Subscription / License activated!');
      await refetchStatus();
    }, 'Verifying with Stripe / license store…');
  };

  const handleDeactivate = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/bridge/billing/deactivate', { method: 'POST' });
      if (res.ok) {
        toast.success('Subscription deactivated on this workstation.');
        await refetchStatus();
      } else {
        toast.error('Unable to deactivate.');
      }
    }, 'Deactivating…');
  };

  const handleOpenPortal = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/bridge/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const j = await res.json();
      if (res.ok && j.portalUrl) {
        window.open(j.portalUrl, '_blank', 'noopener,noreferrer');
      } else {
        toast.info(j.error || 'Complete a Stripe subscription or configure STRIPE_PORTAL_URL first.');
      }
    }, 'Opening Stripe Customer Portal…');
  };

  const ent = statusData?.entitlement;
  const activePlan = ent?.plan;
  const used = ent?.usage?.usedToday ?? 0;
  const limit = ent?.usage?.dailyLimit ?? 3;
  const unlimited = ent?.usage?.unlimited ?? limit < 0;
  const pct = unlimited ? 10 : limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  const plans: PlanInfo[] =
    statusData?.plans && statusData.plans.length > 0
      ? statusData.plans
      : [
          {
            id: 'free',
            name: 'Free Starter',
            priceLabel: '$0/mo',
            features: ['3 Clips/day', '720p Standard Export', 'Local Recordings'],
          },
          {
            id: 'pro',
            name: 'Pro Creator',
            priceLabel: '$12/mo',
            features: ['Unlimited Clips/day', '1080p60 + Auto Captions', 'Audio Peak Scanner', 'AI Virality Score'],
          },
          {
            id: 'ultra',
            name: 'Ultra Studio',
            priceLabel: '$29/mo',
            features: ['Everything in Pro', 'Multi-Stream Watchlist', 'Custom Watermark Branding', 'Priority Processing'],
          },
        ];

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Billing, Plans & Stripe Subscriptions
            </h1>
            <p className="text-sm text-muted-foreground">
              Manage your Stripe subscription, billing portal, daily clipping quotas, or VIP keys.
            </p>
          </div>
          <Button variant="outline" onClick={handleOpenPortal} className="rounded-[16px] font-bold gap-2">
            <ExternalLink className="h-4 w-4" /> Stripe Customer Portal
          </Button>
        </div>

        <MinReveal
          ready={!loadingStatus}
          fallback={
            <div className="grid gap-6 lg:grid-cols-2">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          }
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-lg font-extrabold">
                  <span className="flex items-center gap-2">
                    <CreditCard className="h-5 w-5 text-primary" /> Active Entitlement
                  </span>
                  <Badge className="uppercase">{activePlan?.id || 'free'}</Badge>
                </CardTitle>
                <CardDescription>
                  Plan: <strong>{activePlan?.name || 'Free Starter'}</strong>
                  {ent?.license?.maskedKey ? ` · ID ${ent.license.maskedKey}` : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-bold">
                    <span>Daily Clip Quota</span>
                    <span>{unlimited ? `${used} / Unlimited` : `${used} / ${limit}`}</span>
                  </div>
                  <Progress value={pct} className="h-2.5 rounded-full" />
                </div>
                {ent?.license?.maskedKey && (
                  <Button variant="outline" size="sm" onClick={handleDeactivate} className="rounded-[12px] text-xs gap-1.5">
                    <ShieldAlert className="h-3.5 w-3.5" /> Deactivate Local Activation
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg font-extrabold">
                  <KeyRound className="h-5 w-5 text-[#FF8A30]" /> Activate Subscription or VIP Key
                </CardTitle>
                <CardDescription>
                  Paste your Stripe Subscription ID (<code>sub_...</code>), Checkout Session (<code>cs_...</code>), or Admin VIP key (<code>CLIP-...</code>).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleActivate} className="flex flex-col sm:flex-row gap-3">
                  <Input
                    placeholder="sub_... or cs_... or CLIP-PRO-..."
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value)}
                    className="h-11 rounded-[16px] font-mono"
                  />
                  <Button type="submit" className="h-11 rounded-[16px] font-bold shrink-0">
                    Activate
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 md:grid-cols-3 pt-2">
            {plans.map((plan) => {
              const current = (activePlan?.id || 'free') === plan.id;
              const featList =
                plan.features ??
                [
                  plan.daily_clip_limit && plan.daily_clip_limit < 0
                    ? 'Unlimited clips / day'
                    : `${plan.daily_clip_limit ?? 3} clips / day`,
                  plan.allow_auto_captions ? 'Auto Kinetic Captions' : '720p Standard Export',
                  plan.allow_audio_peak ? 'Audio Peak Hype Scanner' : 'Manual & Chat Triggers',
                  plan.allow_watchlist ? 'Multi-Stream Watchlist' : 'Local Studio Workbench',
                ];

              return (
                <MotionCard
                  key={plan.id}
                  delay={plan.id === 'pro' ? 0.05 : plan.id === 'ultra' ? 0.1 : 0}
                  className="rounded-[24px] p-6 flex flex-col justify-between shadow-[var(--shadow-sm)] border-primary/20"
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-extrabold">{plan.name}</h3>
                      {current && <Badge>Current Plan</Badge>}
                    </div>
                    <p className="text-3xl font-extrabold text-primary">
                      {plan.priceLabel ??
                        (typeof plan.price_usd === 'number'
                          ? `$${plan.price_usd}/mo`
                          : typeof plan.priceMonthly === 'number'
                            ? `$${plan.priceMonthly}/mo`
                            : 'Custom')}
                    </p>
                    <ul className="space-y-2 text-xs text-muted-foreground">
                      {featList.map((f) => (
                        <li key={f} className="flex items-center gap-2">
                          <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Button
                    variant={current ? 'outline' : 'default'}
                    disabled={current || plan.id === 'free'}
                    className="mt-6 w-full h-10 rounded-[14px] font-bold gap-1.5"
                    onClick={async () => {
                      await withLoader(async () => {
                        const res = await fetch('/api/bridge/billing/checkout', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ planId: plan.id }),
                        });
                        const j = await res.json();
                        if (j.checkoutUrl) {
                          triggerCelebrationConfetti();
                          window.open(j.checkoutUrl, '_blank', 'noopener,noreferrer');
                        } else {
                          toast.info(j.error || 'Add STRIPE_SECRET_KEY in .env.local to launch Stripe Checkout.');
                        }
                      }, 'Creating Stripe Checkout session…');
                    }}
                  >
                    <Sparkles className="h-4 w-4" />
                    {current ? 'Active Tier' : `Upgrade with Stripe (${plan.name})`}
                  </Button>
                </MotionCard>
              );
            })}
          </div>
        </MinReveal>
      </div>
    </PageTransition>
  );
}

export default function BillingPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading billing…</div>}>
      <BillingPageContent />
    </React.Suspense>
  );
}
