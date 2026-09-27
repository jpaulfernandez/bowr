import type { Item } from '@bowr/contracts';
import { displayName, tileLabel } from '@bowr/domain';
import { Link } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSpacePress } from '../../components/useSpacePress';
import { PieceImage } from './PieceImage';
import { itemState } from './queries';

const statusText = { processing: 'Processing', needs_attention: 'Needs attention', archived: 'Archived', ready: null } as const;

/**
 * Image, short name and a status only when needed (DESIGN 6.2). In select mode
 * a separate, visible checkbox selects the piece; the tile itself still opens it.
 */
export function PieceTile({ item, size, selection }: { item: Item; size: number; selection?: { selected: boolean; onToggle: () => void } }) {
  const state = itemState(item);
  const status = statusText[state];
  const name = displayName(item);
  const spaceRef = useSpacePress(() => selection?.onToggle());
  return (
    <View role="listitem" style={{ width: size }} className="gap-2">
      {selection ? (
        <Pressable
          ref={spaceRef}
          role="checkbox"
          aria-checked={selection.selected}
          aria-label={`Select ${name}`}
          onPress={selection.onToggle}
          className={`min-h-target flex-row items-center gap-2 rounded-control border px-3 py-2 ${selection.selected ? 'border-accent bg-accent-soft' : 'border-control-border bg-surface'}`}
        >
          <Text aria-hidden className={`text-body ${selection.selected ? 'text-accent' : 'text-text-secondary'}`}>
            {selection.selected ? '☑' : '☐'}
          </Text>
          <Text className={`text-body ${selection.selected ? 'text-accent' : 'text-text'}`}>{selection.selected ? 'Selected' : 'Select'}</Text>
        </Pressable>
      ) : null}
      <Link href={`/wardrobe/items/${item.id}`} aria-label={tileLabel(item, state)} className="gap-2 rounded-image hover:bg-surface-subtle">
        <View className="gap-2">
          <PieceImage item={item} size={size} label="" />
          <Text numberOfLines={2} className="text-body text-text">
            {name}
          </Text>
          {status ? <Text className={`text-secondary ${state === 'needs_attention' ? 'text-error' : 'text-text-secondary'}`}>{status}</Text> : null}
        </View>
      </Link>
    </View>
  );
}
