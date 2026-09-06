import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:opacity-90',
);

export function Button({ className, type = 'button', ...props }: ComponentProps<'button'>) {
  return <button type={type} className={cn(buttonVariants(), className)} {...props} />;
}
