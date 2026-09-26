import type { Item } from '@bowr/contracts';
import { View } from 'react-native';
import { Text } from '../../components/Text';
import { PrivateImage } from '../uploads/PrivateImage';
import { assetFor, stageFor } from './queries';

/**
 * A piece's image in a stable square field. Shows the rendition the member
 * chose: the cutout (or its thumbnail at tile size) when it exists, otherwise
 * the sanitized original. A processing piece keeps its place with a placeholder.
 */
export function PieceImage({
  item,
  size,
  label,
  view,
}: {
  item: Item;
  size: number;
  label: string;
  /** Overrides the member's saved choice (the detail page's Cutout/Original switch). */
  view?: 'cutout' | 'original';
}) {
  const choice = view ?? item.display_image;
  const small = size <= 256;
  const cutout = assetFor(item, small ? 'thumbnail' : 'cutout');
  const original = assetFor(item, 'original');
  const pending = stageFor(item, 'cutout');
  const crop = stageFor(item, 'crop');
  const box = { width: size, height: size };

  // A part of a group photo has no image of its own until it is cropped.
  if (!original && crop && ['queued', 'running', 'retry_wait'].includes(crop.state)) {
    return (
      <View style={box} className="items-center justify-center rounded-image bg-surface-subtle p-2">
        <Text variant="secondary" className="text-center">
          Preparing photo
        </Text>
      </View>
    );
  }
  if (choice === 'cutout' && cutout) {
    return <PrivateImage assetId={cutout.asset_id} variant={small ? 'thumbnail' : 'cutout'} label={label} size={size} />;
  }
  if (choice === 'cutout' && pending && ['queued', 'running', 'retry_wait'].includes(pending.state)) {
    return (
      <View style={box} className="items-center justify-center rounded-image bg-surface-subtle p-2">
        <Text variant="secondary" className="text-center">
          Making cutout
        </Text>
      </View>
    );
  }
  if (original) return <PrivateImage assetId={original.asset_id} variant="original" label={label} size={size} />;
  return <View aria-hidden style={box} className="rounded-image bg-surface-subtle" />;
}
