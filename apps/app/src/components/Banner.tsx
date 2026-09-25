import { View } from 'react-native';
import { Text } from './Text';

type Tone = 'info' | 'success' | 'error' | 'warning';

const toneClass: Record<Tone, string> = {
  info: 'bg-accent-soft border-accent',
  success: 'bg-success-soft border-success',
  error: 'bg-error-soft border-error',
  warning: 'bg-gold-soft border-gold-ink',
};
const textClass: Record<Tone, string> = {
  info: 'text-text',
  success: 'text-success',
  error: 'text-error',
  warning: 'text-gold-ink',
};
const prefix: Record<Tone, string> = { info: 'Note:', success: 'Done:', error: 'Error:', warning: 'Warning:' };

/** Status message with a word prefix, so meaning never depends on color alone. */
export function Banner({ tone = 'info', message, children }: { tone?: Tone; message: string; children?: React.ReactNode }) {
  return (
    <View role={tone === 'error' ? 'alert' : 'status'} className={`gap-2 rounded-control border px-4 py-3 ${toneClass[tone]}`}>
      <Text className={`text-body ${textClass[tone]}`}>
        <Text className={`text-action ${textClass[tone]}`}>{prefix[tone]} </Text>
        {message}
      </Text>
      {children}
    </View>
  );
}
