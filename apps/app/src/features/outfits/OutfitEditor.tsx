import { type Item, type OutfitPiece } from '@bowr/contracts';
import { displayName, outfitCoverage, slotForCategory, validOutfitPieces, outfitSlots, type OutfitSlot } from '@bowr/domain';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { Heading, Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { PieceImage } from '../items/PieceImage';
import { ApiError } from '../../lib/errors';
import { useDeleteOutfit, useLoveOutfit, useOutfit, useOutfitPieces, useSaveOutfit } from './queries';

const slotLabel: Record<OutfitSlot, string> = {
  top: 'Top', bottom: 'Bottom', one_piece: 'One-piece', outerwear: 'Outerwear', shoes: 'Shoes',
  eyewear: 'Eyewear', headwear: 'Headwear', bag: 'Bag', accessory: 'Accessory',
};
const message = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;

export function OutfitEditor({ id }: { id?: string }) {
  const outfit = useOutfit(id);
  const pieces = useOutfitPieces();
  const save = useSaveOutfit();
  const love = useLoveOutfit();
  const remove = useDeleteOutfit();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<OutfitPiece[]>([]);
  const [slotForUnknown, setSlotForUnknown] = useState<OutfitSlot>('accessory');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'warning'; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const initialized = useRef(false);
  const requestKey = useRef<string | null>(null);

  useEffect(() => {
    if (!id || !outfit.data || initialized.current) return;
    setName(outfit.data.name ?? '');
    setSelected([...outfit.data.outfit_items].sort((a, b) => a.ordinal - b.ordinal));
    initialized.current = true;
  }, [id, outfit.data]);

  if (id && outfit.isPending) return <Screen title="Outfit" />;
  if (id && (outfit.isError || !outfit.data)) return <Screen title="Outfit unavailable"><Text>This outfit could not be found.</Text><Button label="Back to Outfits" variant="secondary" onPress={() => router.replace('/outfits')} /></Screen>;
  if (pieces.isPending) return <Screen title={id ? 'Edit outfit' : 'New outfit'} />;
  if (pieces.isError) return <Screen title="Outfits"><Text>Pieces could not load. Check your connection and retry.</Text><Button label="Back to Outfits" variant="secondary" onPress={() => router.replace('/outfits')} /></Screen>;

  const available = pieces.data ?? [];
  const byId = new Map(available.map((piece) => [piece.id, piece]));
  const current = outfit.data;
  const coverage = outfitCoverage(selected);
  const hasUnavailable = selected.some((entry) => !byId.get(entry.item_id) || byId.get(entry.item_id)?.lifecycle !== 'active');
  const add = (piece: Item) => {
    const slot = slotForCategory(piece.category) ?? slotForUnknown;
    const withoutSlot = slot === 'accessory' ? selected : selected.filter((entry) => entry.slot !== slot);
    const next = [...withoutSlot, { item_id: piece.id, slot, ordinal: 0 }].filter((entry, index, all) =>
      all.findIndex((candidate) => candidate.item_id === entry.item_id) === index);
    setSelected(next.map((entry, ordinal) => ({ ...entry, ordinal })));
    setNotice(null);
  };
  const drop = (itemId: string) => setSelected((currentSelection) => currentSelection.filter((entry) => entry.item_id !== itemId)
    .map((entry, ordinal) => ({ ...entry, ordinal })));
  const saveOutfit = () => {
    if (!validOutfitPieces(selected)) {
      setNotice({ tone: 'error', message: 'Choose at least one piece and use each clothing slot once.' });
      return;
    }
    if (selected.some((entry) => !byId.get(entry.item_id))) {
      setNotice({ tone: 'error', message: 'A selected piece was deleted. Remove it before saving.' });
      return;
    }
    requestKey.current ??= crypto.randomUUID();
    save.mutate({ key: requestKey.current, id, revision: current?.revision, name: name.trim() || null, pieces: selected }, {
      onSuccess: (result) => { requestKey.current = null; router.replace(`/outfits/${result.id}`); setNotice({ tone: 'success', message: 'Outfit saved. No wear was logged.' }); },
      onError: (error) => {
        if (error instanceof ApiError && !error.retryable) requestKey.current = null;
        setNotice({ tone: 'error', message: message(error, 'Outfit was not saved. Try again.') });
      },
    });
  };
  const changeLove = () => {
    if (!current) return;
    love.mutate({ key: crypto.randomUUID(), id: current.id, revision: current.revision, loved: !current.loved }, {
      onSuccess: () => setNotice({ tone: 'success', message: current.loved ? 'Removed from loved outfits.' : 'Added to loved outfits. No wear was logged.' }),
      onError: (error) => setNotice({ tone: 'error', message: message(error, 'Preference was not saved.') }),
    });
  };
  const deleteOutfit = () => {
    if (!current) return;
    remove.mutate({ key: crypto.randomUUID(), id: current.id, revision: current.revision }, {
      onSuccess: () => router.replace('/outfits'),
      onError: (error) => { setConfirmDelete(false); setNotice({ tone: 'error', message: message(error, 'Outfit was not deleted.') }); },
    });
  };

  return (
    <Screen title={id ? 'Edit outfit' : 'New outfit'} subtitle="Arrange pieces you own. Saving does not log a wear.">
      {notice ? <Banner tone={notice.tone} message={notice.message} /> : null}
      <View className="max-w-prose gap-4">
        <TextField label="Outfit name (optional)" value={name} maxLength={80} onChangeText={(value) => { setName(value); requestKey.current = null; }} placeholder="e.g. Weekday layers" />
        <View className="gap-2">
          <Heading level={2}>Your arrangement</Heading>
          <Text variant="secondary">{coverage.complete ? 'Complete outfit' : `Partial outfit. Missing: ${coverage.missing.join(', ')}.`}</Text>
          {selected.length === 0 ? <Text>No pieces selected. Choose one below to start.</Text> : null}
          {selected.map((entry) => {
            const piece = byId.get(entry.item_id);
            return <View key={entry.item_id} className="flex-row items-center gap-3 rounded-control border border-divider bg-surface p-2">
              {piece ? <PieceImage item={piece} size={64} label={displayName(piece)} /> : null}
              <View className="min-w-0 flex-1"><Text>{piece ? displayName(piece) : 'Deleted piece'}</Text><Text variant="secondary">{slotLabel[entry.slot]}{piece?.lifecycle === 'archived' ? ' · Archived, restore before new use' : ''}</Text></View>
              <Button label={`Remove ${piece ? displayName(piece) : 'piece'}`} variant="quiet" onPress={() => { drop(entry.item_id); requestKey.current = null; }} />
            </View>;
          })}
        </View>
        {hasUnavailable ? <Banner tone="warning" message="An archived piece remains in this saved outfit. Restore or swap it before a new fit log." /> : null}
        <Button label="Save outfit" busy={save.isPending} onPress={saveOutfit} disabled={!selected.length} />
        {current ? <Button label={current.loved ? 'Remove Love' : 'Love this outfit'} variant="secondary" busy={love.isPending} onPress={changeLove} /> : null}
      </View>
      <View className="gap-4">
        <Heading level={2}>Choose pieces</Heading>
        <Text variant="secondary">Tap a piece to add or replace its slot. Accessories can be added together.</Text>
        {available.some((piece) => piece.lifecycle === 'active' && !piece.category) ? <View className="gap-2"><Text>Slot for uncategorized pieces</Text><View className="flex-row flex-wrap gap-2">{outfitSlots.map((slot) => <Button key={slot} label={slotLabel[slot]} variant={slotForUnknown === slot ? 'primary' : 'secondary'} onPress={() => setSlotForUnknown(slot)} />)}</View></View> : null}
        <View className="flex-row flex-wrap gap-3">
          {available.filter((piece) => piece.lifecycle === 'active' && (piece.name || piece.category)).map((piece) => {
            const chosen = selected.some((entry) => entry.item_id === piece.id);
            return <View key={piece.id} className="w-[144px] gap-2 rounded-control border border-divider bg-surface p-2">
              <PieceImage item={piece} size={120} label={displayName(piece)} />
              <Text numberOfLines={2}>{displayName(piece)}</Text>
              <Button label={chosen ? 'Selected' : `Choose ${displayName(piece)}`} variant={chosen ? 'secondary' : 'quiet'} disabled={chosen} onPress={() => { add(piece); requestKey.current = null; }} />
            </View>;
          })}
        </View>
        {available.filter((piece) => piece.lifecycle === 'active' && (piece.name || piece.category)).length === 0 ? <Text>Add a named or categorized piece in Bower first.</Text> : null}
      </View>
      {current ? <View className="max-w-prose gap-2"><Button label="Delete outfit" variant="destructive" onPress={() => setConfirmDelete(true)} />{confirmDelete ? <View className="gap-2"><Text>Delete this saved outfit? This does not delete its pieces.</Text><Button label="Confirm delete outfit" variant="destructive" busy={remove.isPending} onPress={deleteOutfit} /><Button label="Keep outfit" variant="secondary" onPress={() => setConfirmDelete(false)} /></View> : null}</View> : null}
    </Screen>
  );
}
