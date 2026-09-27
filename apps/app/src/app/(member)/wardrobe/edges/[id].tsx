import { displayName } from '@bowr/domain';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '../../../../components/Button';
import { Screen } from '../../../../components/Screen';
import { Text } from '../../../../components/Text';
import { MaskEditor } from '../../../../features/items/MaskEditor';
import { useItem } from '../../../../features/items/queries';

export default function FixEdges() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useItem(id);
  const back = () => router.replace(`/wardrobe/items/${id}`);
  if (item.isPending) return <Screen title="Fix edges" />;
  if (!item.data) {
    return (
      <Screen title="Fix edges">
        <Text>{item.isError ? "This piece couldn't load." : "This piece isn't in your Bower."}</Text>
        <Button label="Back to Bower" variant="secondary" className="self-start" onPress={() => router.replace('/wardrobe')} />
      </Screen>
    );
  }
  return (
    <Screen title="Fix edges" subtitle={`${displayName(item.data)}. Your original photo is kept; you can undo, reset or cancel.`}>
      <MaskEditor item={item.data} onDone={back} />
    </Screen>
  );
}
