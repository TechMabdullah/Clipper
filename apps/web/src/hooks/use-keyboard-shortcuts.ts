'use client';

import * as React from 'react';

export function useKeyboardShortcuts(handlers: {
  onOpenCommand?: () => void;
}) {
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.onOpenCommand?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
