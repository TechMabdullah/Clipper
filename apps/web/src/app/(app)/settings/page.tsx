'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonForm } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [emailAlerts, setEmailAlerts] = React.useState(true);
  const [clipReadyAlerts, setClipReadyAlerts] = React.useState(true);
  const [marketingUpdates, setMarketingUpdates] = React.useState(false);
  const [reducedMotion, setReducedMotion] = React.useState(false);

  const { data, isLoading } = useQuery<{
    profile?: {
      preferences?: {
        emailAlerts?: boolean;
        clipReadyAlerts?: boolean;
        marketingUpdates?: boolean;
        reducedMotion?: boolean;
      };
    };
  }>({
    queryKey: ['customer-profile-prefs'],
    queryFn: async () => {
      const res = await fetch('/api/customer/profile', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  React.useEffect(() => {
    const prefs = data?.profile?.preferences;
    if (!prefs) return;
    setEmailAlerts(prefs.emailAlerts ?? true);
    setClipReadyAlerts(prefs.clipReadyAlerts ?? true);
    setMarketingUpdates(prefs.marketingUpdates ?? false);
    setReducedMotion(prefs.reducedMotion ?? false);
  }, [data?.profile?.preferences]);

  const handleSave = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/customer/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: { emailAlerts, clipReadyAlerts, marketingUpdates, reducedMotion },
        }),
      });
      if (res.ok) {
        toast.success('Workspace preferences saved!');
      } else {
        toast.error('Unable to save preferences.');
      }
    }, 'Saving preferences…');
  };

  return (
    <PageTransition>
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Workspace Settings</h1>
          <p className="text-sm text-muted-foreground">
            Control alert channels, theme appearance, and motion accessibility preferences.
          </p>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonForm fields={4} />}>
          <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
            <CardHeader>
              <CardTitle className="text-lg font-extrabold">Notifications & Appearance</CardTitle>
              <CardDescription>Preferences persist to your Firestore account document.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="font-bold">Color Theme</Label>
                  <p className="text-xs text-muted-foreground">Choose Light, Dark, or follow System</p>
                </div>
                <div className="flex gap-2">
                  {(['light', 'dark', 'system'] as const).map((t) => (
                    <Button
                      key={t}
                      type="button"
                      size="sm"
                      variant={theme === t ? 'default' : 'outline'}
                      onClick={() => setTheme(t)}
                      className="rounded-[12px] capitalize text-xs font-bold"
                    >
                      {t}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="font-bold">Clip Ready Email Notifications</Label>
                  <p className="text-xs text-muted-foreground">Notify via Resend when a long VOD finishes processing</p>
                </div>
                <Switch checked={clipReadyAlerts} onCheckedChange={setClipReadyAlerts} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="font-bold">Security & Login Alerts</Label>
                  <p className="text-xs text-muted-foreground">Receive alerts for new session logins and OTP requests</p>
                </div>
                <Switch checked={emailAlerts} onCheckedChange={setEmailAlerts} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="font-bold">Product Changelog Updates</Label>
                  <p className="text-xs text-muted-foreground">Occasional feature & AI model upgrades</p>
                </div>
                <Switch checked={marketingUpdates} onCheckedChange={setMarketingUpdates} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="font-bold">Reduced Motion Preference</Label>
                  <p className="text-xs text-muted-foreground">Minimize spring & parallax animations</p>
                </div>
                <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} />
              </div>

              <div className="pt-2 flex justify-end">
                <Button onClick={handleSave} className="h-11 rounded-[16px] font-bold gap-2">
                  <Save className="h-4 w-4" /> Save Settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </MinReveal>
      </div>
    </PageTransition>
  );
}
