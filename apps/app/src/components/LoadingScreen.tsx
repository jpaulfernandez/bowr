import { ActivityIndicator, View } from 'react-native';
import { colors } from '@bowr/design-tokens';
import { Text } from './Text';

/** Neutral state shown before identity and membership are known. No private content. */
export function LoadingScreen({ label = 'Loading bowr' }: { label?: string }) {
  return (
    <View role="status" aria-live="polite" className="flex-1 items-center justify-center gap-3 bg-canvas p-4">
      <ActivityIndicator color={colors.accent} />
      <Text variant="secondary">{label}</Text>
    </View>
  );
}
