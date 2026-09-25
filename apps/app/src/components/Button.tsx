import { ActivityIndicator, Pressable, Text, View, type PressableProps } from 'react-native';
import { colors } from '@bowr/design-tokens';

type Variant = 'primary' | 'secondary' | 'destructive' | 'quiet';

const container: Record<Variant, string> = {
  primary: 'bg-accent hover:bg-accent-hover active:bg-accent-pressed',
  secondary: 'bg-surface border border-control-border hover:bg-surface-subtle active:bg-accent-soft',
  destructive: 'bg-surface border border-error hover:bg-error-soft active:bg-error-soft',
  quiet: 'bg-transparent hover:bg-surface-subtle active:bg-accent-soft',
};
const label: Record<Variant, string> = {
  primary: 'text-on-accent',
  secondary: 'text-text',
  destructive: 'text-error',
  quiet: 'text-accent',
};

type ButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  variant?: Variant;
  busy?: boolean;
  busyLabel?: string;
  className?: string;
};

export function Button({ label: text, variant = 'primary', busy = false, busyLabel, disabled, className = '', ...props }: ButtonProps) {
  const inactive = disabled || busy;
  return (
    <Pressable
      role="button"
      aria-disabled={inactive}
      aria-busy={busy}
      disabled={inactive}
      className={`min-h-target min-w-target flex-row items-center justify-center rounded-control px-4 py-2 ${container[variant]} ${inactive ? 'opacity-60' : ''} ${className}`}
      {...props}
    >
      <View className="flex-row items-center gap-2">
        {busy ? <ActivityIndicator size="small" color={variant === 'primary' ? colors['on-accent'] : colors.accent} /> : null}
        <Text className={`text-action ${label[variant]} text-center`}>{busy && busyLabel ? busyLabel : text}</Text>
      </View>
    </Pressable>
  );
}
