'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import NextTopLoader from 'nextjs-toploader';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { LenisProvider } from './lenis-provider';
import { GlobalPreloader } from '@/components/motion/preloader';
import { GlobalLoaderOverlay } from '@/components/motion/global-loader';
import { SlowRouteOverlay } from '@/components/motion/slow-route-overlay';

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange={false}>
      <QueryClientProvider client={queryClient}>
        <NuqsAdapter>
          <TooltipProvider delayDuration={180}>
            <LenisProvider>
              <NextTopLoader color="#6C63FF" height={3} showSpinner={false} shadow="0 0 10px #6C63FF" />
              <GlobalPreloader />
              <GlobalLoaderOverlay />
              <React.Suspense fallback={null}>
                <SlowRouteOverlay />
              </React.Suspense>
              {children}
              <Toaster richColors position="bottom-right" />
            </LenisProvider>
          </TooltipProvider>
        </NuqsAdapter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
