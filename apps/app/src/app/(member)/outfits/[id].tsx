import { useLocalSearchParams } from 'expo-router';
import { OutfitEditor } from '../../../features/outfits/OutfitEditor';

export default function SavedOutfit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <OutfitEditor id={id} />;
}
