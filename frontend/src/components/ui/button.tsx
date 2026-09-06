import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'ui-button',
  {
    variants: {
      variant: { solid: 'ui-button-solid', ghost: 'ui-button-ghost', floating: 'ui-button-floating' },
      size: { default: 'ui-button-default', icon: 'ui-button-icon' },
    },
    defaultVariants: { variant: 'solid', size: 'default' },
  },
);

export function Button({ className, variant, size, type = 'button', ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
