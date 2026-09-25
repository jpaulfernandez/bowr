import { Modal, View } from 'react-native';
import { Button } from './Button';
import { Heading, Text } from './Text';

/** Focused confirmation for consequential actions (DESIGN 9.3). */
export function ConfirmDialog({
  visible,
  title,
  consequences,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  consequences: string[];
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 items-center justify-center bg-text/40 p-4">
        <View role="dialog" aria-modal aria-label={title} className="w-full max-w-prose gap-4 rounded-sheet bg-surface p-6">
          <Heading level={2}>{title}</Heading>
          <View className="gap-2">
            {consequences.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </View>
          <View className="gap-3">
            <Button label={confirmLabel} variant={destructive ? 'destructive' : 'primary'} busy={busy} onPress={onConfirm} />
            <Button label="Cancel" variant="secondary" disabled={busy} onPress={onCancel} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
