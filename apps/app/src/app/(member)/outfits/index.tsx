import { outfitCoverage } from '@bowr/domain';
import { router } from 'expo-router';
import { View } from 'react-native';
import { Button } from '../../../components/Button';
import { Screen } from '../../../components/Screen';
import { Heading, Text } from '../../../components/Text';
import { useOutfits } from '../../../features/outfits/queries';

export default function Outfits() {
  const outfits = useOutfits();
  return <Screen title="Outfits" subtitle="Saved combinations of your own pieces">
    <View className="max-w-prose gap-3"><Button label="Create outfit" onPress={() => router.push('/outfits/new')} /><Text variant="secondary">Save a combination now. Wear logging arrives in Strut.</Text></View>
    {outfits.isPending ? <Text>Loading outfits…</Text> : null}
    {outfits.isError ? <Text>Outfits could not load. Check your connection and retry.</Text> : null}
    {outfits.data?.length === 0 ? <Text>No saved outfits yet. Start with a few pieces you already own.</Text> : null}
    <View className="gap-3">{outfits.data?.map((outfit) => {
      const coverage = outfitCoverage(outfit.outfit_items);
      return <View key={outfit.id} className="max-w-prose gap-2 rounded-control border border-divider bg-surface p-4">
        <Heading level={2}>{outfit.name ?? 'Untitled outfit'}{outfit.loved ? ' · Loved' : ''}</Heading>
        <Text variant="secondary">{outfit.outfit_items.length} {outfit.outfit_items.length === 1 ? 'piece' : 'pieces'} · {coverage.complete ? 'Complete' : 'Partial'}</Text>
        <Button label={`Open ${outfit.name ?? 'untitled outfit'}`} variant="secondary" onPress={() => router.push(`/outfits/${outfit.id}`)} />
      </View>;
    })}</View>
  </Screen>;
}
