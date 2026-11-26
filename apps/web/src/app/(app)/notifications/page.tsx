'use client';

import * as React from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageTransition } from '@/components/motion/page-transition';
import { MinReveal, SkeletonList } from '@/components/skeletons';
import { useRealtimeNotifications } from '@/hooks/use-realtime-notifications';

export default function NotificationsPage() {
  const { notifications, unreadCount, isLoading, markRead } = useRealtimeNotifications(true);
  const [filter, setFilter] = React.useState<'all' | 'unread'>('all');

  const items = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  return (
    <PageTransition>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Notifications</h1>
            <p className="text-sm text-muted-foreground">
              Live clipping completion alerts, billing receipts, and system updates.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              className="rounded-full text-xs font-bold"
              onClick={() => setFilter('all')}
            >
              All ({notifications.length})
            </Button>
            <Button
              variant={filter === 'unread' ? 'default' : 'outline'}
              size="sm"
              className="rounded-full text-xs font-bold"
              onClick={() => setFilter('unread')}
            >
              Unread ({unreadCount})
            </Button>
            {unreadCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-[14px] text-xs font-bold gap-1.5"
                onClick={() => markRead.mutate({ markAllRead: true })}
              >
                <CheckCheck className="h-4 w-4" /> Mark all read
              </Button>
            )}
          </div>
        </div>

        <MinReveal ready={!isLoading} fallback={<SkeletonList items={5} />}>
          <div className="space-y-3">
            {items.length === 0 ? (
              <Card className="rounded-[24px] p-12 text-center text-sm text-muted-foreground">
                <Bell className="mx-auto mb-2 h-6 w-6 opacity-40" />
                No notifications to show in this filter.
              </Card>
            ) : (
              items.map((n) => (
                <Card
                  key={n.id}
                  className="rounded-[20px] p-4 flex items-center justify-between gap-4 shadow-[var(--shadow-sm)]"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-extrabold">{n.title}</span>
                      {!n.read && <Badge className="text-[10px]">Unread</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{n.body}</p>
                    {n.createdAt && (
                      <p className="text-[11px] text-muted-foreground/75">
                        {formatDistanceToNow(n.createdAt, { addSuffix: true })}
                      </p>
                    )}
                  </div>
                  {!n.read && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs font-bold"
                      onClick={() => markRead.mutate({ id: n.id, read: true })}
                    >
                      Mark read
                    </Button>
                  )}
                </Card>
              ))
            )}
          </div>
        </MinReveal>
      </div>
    </PageTransition>
  );
}
