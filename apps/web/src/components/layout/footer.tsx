import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

export function AppFooter({ surface }: { surface: 'customer' | 'admin' }) {
  return (
    <footer className="mt-10 border-t border-border/70 px-6 py-5 text-xs text-muted-foreground mb-16 md:mb-0">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="font-semibold text-foreground">Clipper Studio</span>
          <span>·</span>
          <span>
            {surface === 'admin' ? 'Zero-Trust Admin Operations' : 'AI Clip Engine & Creator Cloud'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 font-medium">
          <Link href="/support" className="hover:text-foreground transition">
            Support
          </Link>
          <Link href="/sessions" className="hover:text-foreground transition">
            Security & Sessions
          </Link>
          <Link href="/billing" className="hover:text-foreground transition">
            Plans & Licensing
          </Link>
          <span className="opacity-70">© {new Date().getFullYear()} Clipper Studio</span>
        </div>
      </div>
    </footer>
  );
}
