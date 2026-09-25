import { Text as RNText, type TextProps } from 'react-native';

type Variant = 'page-title' | 'section-title' | 'subheading' | 'body' | 'secondary';

const variantClass: Record<Variant, string> = {
  'page-title': 'text-page-title text-text',
  'section-title': 'text-section-title text-text',
  subheading: 'text-subheading text-text',
  body: 'text-body text-text',
  secondary: 'text-secondary text-text-secondary',
};

export function Text({ variant = 'body', className = '', ...props }: TextProps & { variant?: Variant; className?: string }) {
  return <RNText className={`${variantClass[variant]} ${className}`} {...props} />;
}

export function Heading({ level = 1, className = '', ...props }: TextProps & { level?: 1 | 2 | 3; className?: string }) {
  const variant: Variant = level === 1 ? 'page-title' : level === 2 ? 'section-title' : 'subheading';
  return <Text role="heading" aria-level={level} variant={variant} className={className} {...props} />;
}
