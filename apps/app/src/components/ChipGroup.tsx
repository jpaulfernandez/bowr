import { Pressable, Text, View } from 'react-native';
import { useSpacePress } from './useSpacePress';

type Option<T extends string> = { value: T; label: string; swatch?: string };

/**
 * Multi-select chips (checkbox semantics). Selection shows a checkmark and an
 * accent outline, so it never depends on color alone (DESIGN 9.2, 10).
 */
export function ChipGroup<T extends string>({
  label,
  values,
  options,
  onChange,
  max,
  hint,
}: {
  label: string;
  values: readonly T[];
  options: ReadonlyArray<Option<T>>;
  onChange: (values: T[]) => void;
  max?: number;
  hint?: string;
}) {
  const full = max !== undefined && values.length >= max;
  return (
    <View role="group" aria-label={label} className="gap-1">
      <Text className="text-action text-text">{label}</Text>
      {hint ? <Text className="text-secondary text-text-secondary">{hint}</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => {
          const checked = values.includes(option.value);
          return (
            <Chip
              key={option.value}
              option={option}
              checked={checked}
              disabled={!checked && full}
              onToggle={() => onChange(checked ? values.filter((v) => v !== option.value) : [...values, option.value])}
            />
          );
        })}
      </View>
    </View>
  );
}

function Chip<T extends string>({ option, checked, disabled, onToggle }: { option: Option<T>; checked: boolean; disabled: boolean; onToggle: () => void }) {
  const ref = useSpacePress(() => !disabled && onToggle());
  return (
    <Pressable
      ref={ref}
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onToggle}
      className={`min-h-target flex-row items-center gap-2 rounded-full border px-3 py-2 ${checked ? 'border-accent bg-accent-soft' : 'border-control-border bg-surface'} ${disabled ? 'opacity-60' : ''}`}
    >
      {option.swatch ? (
        <View aria-hidden style={{ width: 16, height: 16, backgroundColor: option.swatch }} className="rounded-full border border-control-border" />
      ) : null}
      <Text className={`text-body ${checked ? 'text-accent' : 'text-text'}`}>{option.label}</Text>
      {checked ? (
        <Text aria-hidden className="text-body text-accent">
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}
