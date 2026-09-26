import { forwardRef, useId } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { colors } from '@bowr/design-tokens';
import { Text } from './Text';

type TextFieldProps = TextInputProps & { label: string; hint?: string; error?: string | undefined };

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField({ label, hint, error, ...props }, ref) {
  const id = useId().replace(/:/g, '');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <View className="gap-1">
      <Text nativeID={`${id}-label`} className="text-action text-text">
        {label}
      </Text>
      {hint ? (
        <Text nativeID={hintId} variant="secondary">
          {hint}
        </Text>
      ) : null}
      <TextInput
        ref={ref}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        placeholderTextColor={colors['text-secondary']}
        className={`min-h-target rounded-control border bg-surface px-3 text-body text-text ${error ? 'border-error' : 'border-control-border'}`}
        {...props}
      />
      {error ? (
        <Text nativeID={errorId} className="text-secondary text-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
});
