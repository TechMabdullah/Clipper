'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning';
  read?: boolean;
  href?: string;
  createdAt?: number;
}

export function useRealtimeNotifications(enabled = true) {
  const queryClient = useQueryClient();

  const query = useQuery<{ notifications: NotificationItem[]; unreadCount: number }>({
    queryKey: ['customer-notifications'],
    queryFn: async () => {
      const res = await fetch('/api/customer/notifications', { cache: 'no-store' });
      if (!res.ok) return { notifications: [], unreadCount: 0 };
      return res.json();
    },
    enabled,
    refetchInterval: 25_000,
  });

  const markRead = useMutation({
    mutationFn: async (payload: { id?: string; markAllRead?: boolean; read?: boolean }) => {
      await fetch('/api/customer/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer-notifications'] });
    },
  });

  return {
    notifications: query.data?.notifications ?? [],
    unreadCount: query.data?.unreadCount ?? 0,
    isLoading: query.isLoading,
    markRead,
  };
}
