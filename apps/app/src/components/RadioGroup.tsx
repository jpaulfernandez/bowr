import { Pressable, Text, View } from 'react-native';

type Option<T extends string> = { value: T; label: string };

export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  /** Null when nothing is chosen yet. */
  value: T | null;
  options: Array<Option<T>>;
  onChange: (value: T) => void;
}) {
  return (
    <View role="radiogroup" aria-label={label} className="gap-1">
      <Text className="text-action text-text">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <Pressable
              key={option.value}
              role="radio"
              aria-checked={checked}
              onPress={() => onChange(option.value)}
              className={`min-h-target flex-row items-center gap-2 rounded-control border px-3 py-2 ${checked ? 'border-accent bg-accent-soft' : 'border-control-border bg-surface'}`}
            >
              <Text aria-hidden className={`text-body ${checked ? 'text-accent' : 'text-text-secondary'}`}>
                {checked ? '●' : '○'}
              </Text>
              <Text className={`text-body ${checked ? 'text-accent' : 'text-text'}`}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
