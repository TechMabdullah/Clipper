'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AmbientGlow } from '@/components/animated/ambient-glow';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="min-h-screen flex flex-col justify-center items-center bg-background p-4 sm:p-6 lg:p-10 relative overflow-hidden">
      <AmbientGlow />
      <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="h-10 w-10 rounded-[14px] bg-card/80 backdrop-blur"
          aria-label="Toggle color theme"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </div>
      <div className="w-full max-w-5xl rounded-[32px] border border-border bg-card p-3 sm:p-5 shadow-[var(--shadow-lg)]">
        {children}
      </div>
    </div>
  );
}
