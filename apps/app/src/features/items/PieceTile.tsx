import type { Item } from '@bowr/contracts';
import { displayName, tileLabel } from '@bowr/domain';
import { Link } from 'expo-router';
import { Text, View } from 'react-native';
import { PieceImage } from './PieceImage';
import { itemState } from './queries';

const statusText = { processing: 'Processing', needs_attention: 'Needs attention', archived: 'Archived', ready: null } as const;

/** Image, short name and a status only when needed (DESIGN 6.2). */
export function PieceTile({ item, size }: { item: Item; size: number }) {
  const state = itemState(item);
  const status = statusText[state];
  return (
    <View role="listitem" style={{ width: size }}>
      <Link href={`/wardrobe/items/${item.id}`} aria-label={tileLabel(item, state)} className="gap-2 rounded-image hover:bg-surface-subtle">
        <View className="gap-2">
          <PieceImage item={item} size={size} label="" />
          <Text numberOfLines={2} className="text-body text-text">
            {displayName(item)}
          </Text>
          {status ? <Text className={`text-secondary ${state === 'needs_attention' ? 'text-error' : 'text-text-secondary'}`}>{status}</Text> : null}
        </View>
      </Link>
    </View>
  );
}
