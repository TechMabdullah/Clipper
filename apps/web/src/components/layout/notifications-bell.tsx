'use client';

import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useRealtimeNotifications } from '@/hooks/use-realtime-notifications';

export function NotificationsBell() {
  const { notifications, unreadCount, markRead } = useRealtimeNotifications(true);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-[14px]"
          aria-label={`Notifications (${unreadCount} unread)`}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FF5FA2] px-1 text-[10px] font-extrabold text-white shadow-sm">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-[22px] p-0 shadow-[var(--shadow-2)]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-bold">Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-primary"
              onClick={() => markRead.mutate({ markAllRead: true })}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>
        <ScrollArea className="max-h-72">
          {notifications.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              You are completely caught up. Clip alerts and status updates will show here.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {notifications.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col gap-1 px-4 py-3 text-left transition hover:bg-muted/40"
                  onClick={() => !item.read && markRead.mutate({ id: item.id, read: true })}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-foreground">{item.title}</span>
                    {!item.read && <span className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{item.body}</p>
                  {item.createdAt && (
                    <span className="text-[10px] text-muted-foreground/80">
                      {formatDistanceToNow(item.createdAt, { addSuffix: true })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <div className="border-t border-border p-2">
          <Button variant="ghost" size="sm" className="w-full justify-center text-xs font-semibold" asChild>
            <Link href="/notifications">View all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
