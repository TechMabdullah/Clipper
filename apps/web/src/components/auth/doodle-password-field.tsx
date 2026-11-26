'use client';

import * as React from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useDoodleStore } from '@/stores/doodle-store';
import { cn } from '@/lib/utils';

interface DoodlePasswordFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  fieldKey?: 'password' | 'confirm';
  showStrength?: boolean;
  hasError?: boolean;
}

function getPasswordStrength(value: string): { score: number; label: string; color: string } {
  let score = 0;
  if (value.length >= 8) score += 1;
  if (/[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;

  if (score <= 1) return { score, label: 'Weak', color: 'bg-destructive' };
  if (score === 2) return { score, label: 'Fair', color: 'bg-[#FF8A30]' };
  if (score === 3) return { score, label: 'Good', color: 'bg-[#FFD43B]' };
  return { score, label: 'Strong', color: 'bg-emerald-500' };
}

export const DoodlePasswordField = React.forwardRef<HTMLInputElement, DoodlePasswordFieldProps>(
  ({ className, fieldKey = 'password', showStrength = false, hasError, onFocus, onBlur, onChange, value, ...props }, ref) => {
    const [shown, setShown] = React.useState(false);
    const { setFocusedField, setPasswordVisible, setTyping } = useDoodleStore();

    const toggleShown = () => {
      const next = !shown;
      setShown(next);
      setPasswordVisible(next);
    };

    const strVal = typeof value === 'string' ? value : '';
    const strength = showStrength && strVal ? getPasswordStrength(strVal) : null;

    return (
      <div className="space-y-1.5">
        <div className={cn('relative flex items-center', hasError && 'animate-auth-shake')}>
          <Lock className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={ref}
            type={shown ? 'text' : 'password'}
            value={value}
            onFocus={(e) => {
              setFocusedField(fieldKey);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocusedField('none');
              onBlur?.(e);
            }}
            onChange={(e) => {
              setTyping(true);
              onChange?.(e);
            }}
            className={cn(
              'h-11 rounded-[16px] pl-10 pr-11 text-sm',
              hasError && 'border-destructive focus-visible:ring-destructive',
              className,
            )}
            {...props}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleShown}
            aria-label={shown ? 'Hide password' : 'Show password'}
            className="absolute right-1.5 h-8 w-8 rounded-[12px] text-muted-foreground hover:text-foreground"
          >
            {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {strength && (
          <div className="flex items-center justify-between gap-3 px-1">
            <div className="flex flex-1 gap-1.5">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cn(
                    'h-1.5 flex-1 rounded-full transition-colors',
                    strength.score >= step ? strength.color : 'bg-muted',
                  )}
                />
              ))}
            </div>
            <span className="text-[11px] font-bold text-muted-foreground">{strength.label}</span>
          </div>
        )}
      </div>
    );
  },
);
DoodlePasswordField.displayName = 'DoodlePasswordField';
