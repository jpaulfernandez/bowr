import type { Item } from '@bowr/contracts';
import { View } from 'react-native';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';

/**
 * Edge correction is a web tool for now (native camera and editing arrive in
 * phase 8). Every piece can still use its original, try the other cutout model
 * or have its photo replaced from the piece page.
 */
export function MaskEditor({ onDone }: { item: Item; onDone: () => void }) {
  return (
    <View className="gap-3">
      <Text>Edge editing is available in the web app. On this device, use the original photo, try the other cutout model or replace the photo.</Text>
      <Button label="Back to piece" variant="secondary" className="self-start" onPress={onDone} />
    </View>
  );
}
