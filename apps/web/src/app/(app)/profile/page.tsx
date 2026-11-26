'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import ReactCrop, { type Crop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Download, Save, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonForm } from '@/components/skeletons';
import { withLoader } from '@/stores/loader-store';
import { signOutClient } from '@/lib/firebase';

export default function ProfilePage() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [bio, setBio] = React.useState('');
  const [creatorHandle, setCreatorHandle] = React.useState('');
  const [picture, setPicture] = React.useState('');
  const [confirmDeleteEmail, setConfirmDeleteEmail] = React.useState('');

  // Image crop state
  const [cropSrc, setCropSrc] = React.useState<string | null>(null);
  const [crop, setCrop] = React.useState<Crop>({ unit: '%', x: 10, y: 10, width: 80, height: 80 });
  const imgRef = React.useRef<HTMLImageElement | null>(null);

  const { data, isLoading, refetch } = useQuery<{
    profile?: {
      uid: string;
      email: string;
      name: string;
      picture?: string;
      bio?: string;
      creatorHandle?: string;
      role: string;
      providers?: string[];
    };
  }>({
    queryKey: ['customer-profile'],
    queryFn: async () => {
      const res = await fetch('/api/customer/profile', { cache: 'no-store' });
      return res.ok ? res.json() : {};
    },
  });

  React.useEffect(() => {
    const p = data?.profile;
    if (!p) return;
    setName(p.name || '');
    setBio(p.bio || '');
    setCreatorHandle(p.creatorHandle || '');
    setPicture(p.picture || '');
  }, [data?.profile]);

  const handleSelectAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropSrc(String(reader.result));
    reader.readAsDataURL(file);
  };

  const applyCroppedAvatar = async () => {
    if (!imgRef.current) return;
    const img = imgRef.current;
    const canvas = document.createElement('canvas');
    const size = 256;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scaleX = img.naturalWidth / img.width;
    const scaleY = img.naturalHeight / img.height;
    const sx = (crop.unit === '%' ? (crop.x / 100) * img.width : crop.x) * scaleX;
    const sy = (crop.unit === '%' ? (crop.y / 100) * img.height : crop.y) * scaleY;
    const sw = (crop.unit === '%' ? (crop.width / 100) * img.width : crop.width) * scaleX;
    const sh = (crop.unit === '%' ? (crop.height / 100) * img.height : crop.height) * scaleY;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/webp', 0.85);
    setPicture(dataUrl);
    setCropSrc(null);
    toast.success('Cropped avatar ready — click Save Profile to apply.');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await withLoader(async () => {
      const res = await fetch('/api/customer/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, bio, creatorHandle, picture }),
      });
      if (!res.ok) {
        toast.error('Failed to save profile.');
        return;
      }
      toast.success('Profile updated!');
      await refetch();
      router.refresh();
    }, 'Saving profile changes…');
  };

  const handleDeleteAccount = async () => {
    await withLoader(async () => {
      const res = await fetch('/api/customer/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail: confirmDeleteEmail }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || 'Account deletion failed.');
        return;
      }
      await signOutClient();
      toast.success('Account permanently deleted.');
      router.push('/login');
    }, 'Deleting account & revoking sessions…');
  };

  const profile = data?.profile;

  return (
    <PageTransition>
      <div className="space-y-6 max-w-4xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Creator Profile</h1>
          <p className="text-sm text-muted-foreground">
            Customize your identity, crop avatar, export your personal data, or manage account deletion.
          </p>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonForm fields={5} />}>
          <form onSubmit={handleSave} className="space-y-6">
            <Card className="rounded-[24px] p-6 shadow-[var(--shadow-sm)] space-y-5">
              <div className="flex flex-wrap items-center gap-5">
                <Avatar className="h-20 w-20 border-2 border-primary/30">
                  <AvatarImage src={picture || undefined} />
                  <AvatarFallback className="text-xl font-extrabold bg-primary/15 text-primary">
                    {(name || profile?.email || 'C').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-base">{profile?.name || 'Creator'}</span>
                    <Badge variant="secondary" className="uppercase text-[10px]">
                      {profile?.role || 'customer'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{profile?.email}</p>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-[14px] border border-border bg-muted/40 px-3 py-1.5 text-xs font-bold hover:bg-muted transition">
                    <Upload className="h-3.5 w-3.5 text-primary" /> Upload & Crop Avatar
                    <input type="file" accept="image/*" className="hidden" onChange={handleSelectAvatar} />
                  </label>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Display Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="h-11 rounded-[16px]" />
                </div>
                <div className="space-y-1.5">
                  <Label>Creator Handle</Label>
                  <Input
                    placeholder="@alexclips"
                    value={creatorHandle}
                    onChange={(e) => setCreatorHandle(e.target.value)}
                    className="h-11 rounded-[16px]"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Bio / Watermark Tagline</Label>
                <Textarea
                  rows={3}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  className="rounded-[16px]"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  Linked providers:{' '}
                  {(profile?.providers ?? ['password']).map((pr) => (
                    <Badge key={pr} variant="outline" className="text-[10px]">{pr}</Badge>
                  ))}
                </div>
                <Button type="submit" className="h-11 rounded-[16px] font-bold gap-2">
                  <Save className="h-4 w-4" /> Save Profile
                </Button>
              </div>
            </Card>
          </form>

          <Card className="rounded-[24px] shadow-[var(--shadow-sm)]">
            <CardHeader>
              <CardTitle className="text-base font-extrabold">Privacy & Danger Zone</CardTitle>
              <CardDescription>Download your full JSON account bundle or permanently erase your account.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <Button variant="outline" className="rounded-[16px] font-bold gap-2" asChild>
                <a href="/api/customer/account">
                  <Download className="h-4 w-4" /> Export Personal Data (JSON)
                </a>
              </Button>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" className="rounded-[16px] font-bold gap-2">
                    <Trash2 className="h-4 w-4" /> Delete Account
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-[24px]">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Permanently delete your account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Type your email address (<strong>{profile?.email}</strong>) to confirm permanent deletion.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <Input
                    placeholder={profile?.email || 'confirm email'}
                    value={confirmDeleteEmail}
                    onChange={(e) => setConfirmDeleteEmail(e.target.value)}
                    className="rounded-[14px]"
                  />
                  <AlertDialogFooter>
                    <AlertDialogCancel className="rounded-[14px]">Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDeleteAccount} className="rounded-[14px] bg-destructive text-white">
                      Confirm Deletion
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </MinReveal>

        <Dialog open={Boolean(cropSrc)} onOpenChange={(o) => !o && setCropSrc(null)}>
          <DialogContent className="rounded-[26px]">
            <DialogHeader>
              <DialogTitle>Crop Avatar</DialogTitle>
            </DialogHeader>
            {cropSrc && (
              <div className="flex justify-center max-h-96 overflow-auto">
                <ReactCrop crop={crop} aspect={1} onChange={(c) => setCrop(c)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img ref={imgRef} src={cropSrc} alt="Avatar crop preview" className="max-h-80" />
                </ReactCrop>
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setCropSrc(null)}>Cancel</Button>
              <Button onClick={applyCroppedAvatar} className="rounded-[14px] font-bold">Apply Crop</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageTransition>
  );
}
