import {
  activeFilterCount,
  bowerQueryParams,
  categories,
  categoryLabel,
  emptyBowerQuery,
  parseBowerQuery,
  type BowerQuery,
  type Category,
} from '@bowr/domain';
import { useQuery } from '@tanstack/react-query';
import { Link, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text as RNText, View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { RadioGroup } from '../../../components/RadioGroup';
import { Prose, Screen } from '../../../components/Screen';
import { Heading, Text } from '../../../components/Text';
import { TextField } from '../../../components/TextField';
import { ActiveFilters, BowerFilters } from '../../../features/items/BowerFilters';
import { PieceTile } from '../../../features/items/PieceTile';
import { useBulkUpdate, useDeletionStatus, useSearchItems, type BulkOperation } from '../../../features/items/queries';
import { guardedRead } from '../../../lib/api';
import { ApiError } from '../../../lib/errors';
import { formatDateTime } from '../../../lib/format';
import { userKeys } from '../../../lib/query-keys';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';

const Batches = z.array(z.object({ id: z.string().uuid(), entry_count: z.number().int(), created_at: z.string() }));

const GAP = 12;
const MIN_TILE = 152;
const MAX_SELECTED = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns from the actual available width: at least two, tiles near 152 px (DESIGN 5.3). */
function grid(width: number) {
  const columns = Math.max(2, Math.floor((width + GAP) / (MIN_TILE + GAP)));
  return { columns, size: Math.floor((width - GAP * (columns - 1)) / columns) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function noResultsText(query: BowerQuery) {
  const filters = activeFilterCount(query);
  const text = query.q.trim();
  if (query.archived && !text && filters === 1) return 'No archived pieces.';
  if (text && filters) return `No pieces match "${text}" with ${plural(filters, 'filter')}.`;
  if (text) return `No pieces match "${text}".`;
  return `No pieces match ${plural(filters, 'filter')}.`;
}

/** A piece deleted from its page: pending until its images are confirmed gone. */
function DeletionNotice({ itemId }: { itemId: string }) {
  const status = useDeletionStatus(itemId);
  if (!status.data) return null;
  return (
    <Text role="status" aria-live="polite" className="max-w-prose text-body text-text">
      {status.data.state === 'deleted' ? 'Piece deleted. Its photos are gone.' : 'Deleting the piece. Its photos are being removed.'}
    </Text>
  );
}

export default function Bower() {
  const { userId } = useSession();
  const params = useLocalSearchParams<Record<string, string>>();
  // The page's own state is the source of truth; the route mirrors it so a
  // piece's back button restores it (reading params back would lag a click behind).
  const [query, setQuery] = useState(() => parseBowerQuery(params));
  const deleted = typeof params.deleted === 'string' && UUID.test(params.deleted) ? params.deleted : undefined;
  const [text, setText] = useState(query.q);
  const [showFilters, setShowFilters] = useState(false);
  const [width, setWidth] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, { id: string; revision: number }>>(new Map());
  const [newCategory, setNewCategory] = useState<Category | null>(null);
  const [choosingCategory, setChoosingCategory] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const bulkKey = useRef<string | null>(null);
  const items = useSearchItems(query);
  const bulk = useBulkUpdate();

  // Filters and sort live in the route, so a piece's back button restores them.
  // Defaults are passed as undefined, which removes them from the URL.
  const update = setQuery;
  useEffect(() => {
    router.setParams(bowerQueryParams(query));
  }, [query]);
  // Text search follows typing after a short pause; other changes made meanwhile are kept.
  useEffect(() => {
    const timer = setTimeout(() => setQuery((current) => (current.q === text ? current : { ...current, q: text })), 250);
    return () => clearTimeout(timer);
  }, [text]);

  const receipts = useQuery({
    queryKey: [...userKeys.all(userId ?? 'none'), 'upload-batches', 'recent'],
    queryFn: async ({ signal }) =>
      Batches.parse(
        await guardedRead(() =>
          supabase
            .from('upload_batches')
            .select('id, entry_count, created_at')
            .order('created_at', { ascending: false })
            .order('id')
            .limit(5)
            .abortSignal(signal),
        ),
      ),
    enabled: userId !== null,
  });

  const pages = items.data?.pages ?? [];
  const pieces = pages.flatMap((page) => page.items);
  const total = pages[0]?.total;
  const processing = pages[0]?.processing ?? 0;
  const searching = query.q.trim() !== '' || activeFilterCount(query) > 0;
  const { size } = grid(width);

  const toggle = (id: string, revision: number) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SELECTED) next.set(id, { id, revision });
      return next;
    });
  const endSelection = () => {
    setSelecting(false);
    setSelected(new Map());
    setChoosingCategory(false);
    setNewCategory(null);
    bulkKey.current = null;
  };
  const runBulk = (operation: BulkOperation, done: string) => {
    setNotice(null);
    bulkKey.current ??= crypto.randomUUID();
    bulk.mutate(
      { items: Array.from(selected.values()), operation, key: bulkKey.current },
      {
        onSuccess: () => {
          setNotice({ tone: 'success', message: done });
          endSelection();
        },
        onError: (error) => {
          bulkKey.current = null;
          setNotice({
            tone: 'error',
            message:
              error instanceof ApiError && error.code === 'REVISION_CONFLICT'
                ? 'Some selected pieces changed elsewhere, so nothing was changed. Check them and try again.'
                : error instanceof ApiError
                  ? `Nothing was changed. ${error.message}`
                  : 'Nothing was changed. Try again.',
          });
        },
      },
    );
  };
  const count = selected.size;
  const pieceWord = plural(count, 'piece');

  return (
    <Screen title="Bower" subtitle={query.archived ? 'Archived pieces' : 'Your wardrobe'}>
      <View className="max-w-prose gap-3">
        <Button label="Gather" onPress={() => router.push('/wardrobe/gather')} />
      </View>
      {deleted ? <DeletionNotice itemId={deleted} /> : null}
      {notice ? <Banner tone={notice.tone} message={notice.message} /> : null}
      <View className="max-w-prose gap-3">
        <TextField
          label="Search pieces"
          value={text}
          onChangeText={setText}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        <View role="toolbar" aria-label="Browse" className="flex-row flex-wrap items-center gap-2">
          <Button
            label={activeFilterCount(query) ? `Filters (${activeFilterCount(query)})` : 'Filters'}
            variant="secondary"
            aria-expanded={showFilters}
            onPress={() => setShowFilters(!showFilters)}
          />
          {pieces.length > 0 ? (
            <Button label={selecting ? 'Done selecting' : 'Select'} variant="secondary" onPress={() => (selecting ? endSelection() : setSelecting(true))} />
          ) : null}
        </View>
        {showFilters ? <BowerFilters query={query} onChange={update} /> : null}
        <ActiveFilters query={query} onChange={update} />
      </View>
      {items.isError ? <Banner tone="error" message="Your pieces couldn't load. Check your connection and try again." /> : null}
      {total !== undefined ? (
        <View className="flex-row flex-wrap gap-x-3" role="status" aria-live="polite">
          <Text className="text-body text-text">{plural(total, 'piece')}</Text>
          {processing > 0 ? <Text variant="secondary">{`${processing} processing`}</Text> : null}
        </View>
      ) : null}
      {items.isSuccess && total === 0 && !searching ? (
        <Prose>
          <Text>Your Bower is empty. Gather your first piece.</Text>
          <Text variant="secondary">Start with a few pieces you wear often. Pieces you add are visible only to you.</Text>
        </Prose>
      ) : null}
      {items.isSuccess && total === 0 && searching ? (
        <View className="max-w-prose gap-3">
          <Text>{noResultsText(query)}</Text>
          <Button
            label="Clear search and filters"
            variant="secondary"
            className="self-start"
            onPress={() => {
              setText('');
              update({ ...emptyBowerQuery, sort: query.sort });
            }}
          />
        </View>
      ) : null}
      {selecting ? (
        <View role="region" aria-label="Selected pieces" className="max-w-prose gap-3 rounded-control border border-divider bg-surface p-3">
          <Text role="status" aria-live="polite">
            {count === MAX_SELECTED ? `${count} selected (the most at once)` : `${count} selected`}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {query.archived ? (
              <Button label={`Restore ${pieceWord}`} disabled={count === 0} busy={bulk.isPending} onPress={() => runBulk({ kind: 'restore' }, `${plural(count, 'piece')} restored.`)} />
            ) : (
              <>
                <Button label="Change category" variant="secondary" disabled={count === 0} aria-expanded={choosingCategory} onPress={() => setChoosingCategory(!choosingCategory)} />
                <Button label={`Archive ${pieceWord}`} variant="secondary" disabled={count === 0} busy={bulk.isPending} onPress={() => runBulk({ kind: 'archive' }, `${plural(count, 'piece')} archived.`)} />
              </>
            )}
            <Button label="Clear selection" variant="quiet" disabled={count === 0} onPress={() => setSelected(new Map())} />
          </View>
          {choosingCategory && !query.archived ? (
            <View className="gap-3">
              <RadioGroup
                label="New category"
                value={newCategory}
                options={categories.map((c) => ({ value: c, label: categoryLabel[c] }))}
                onChange={setNewCategory}
              />
              <Button
                label={`Apply to ${pieceWord}`}
                className="self-start"
                disabled={count === 0 || newCategory === null}
                busy={bulk.isPending}
                onPress={() => newCategory && runBulk({ kind: 'category', category: newCategory }, `Category changed for ${pieceWord}.`)}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {pieces.length > 0 ? (
        <View className="gap-4" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          <Heading level={2}>Pieces</Heading>
          {width > 0 ? (
            <View role="list" aria-label="Pieces" className="flex-row flex-wrap" style={{ gap: GAP }}>
              {pieces.map((item) => (
                <PieceTile
                  key={item.id}
                  item={item}
                  size={size}
                  selection={selecting ? { selected: selected.has(item.id), onToggle: () => toggle(item.id, item.revision) } : undefined}
                />
              ))}
            </View>
          ) : null}
          {items.hasNextPage ? (
            <Button
              label="Show more pieces"
              variant="secondary"
              className="self-start"
              busy={items.isFetchingNextPage}
              busyLabel="Loading pieces"
              onPress={() => void items.fetchNextPage()}
            />
          ) : (
            <Text variant="secondary">{`That's everything: ${plural(pieces.length, 'piece')}.`}</Text>
          )}
        </View>
      ) : null}
      {receipts.data && receipts.data.length > 0 ? (
        <View className="max-w-prose gap-3">
          <Heading level={2}>Recent uploads</Heading>
          <View role="list" className="overflow-hidden rounded-control border border-divider bg-surface">
            {receipts.data.map((batch, index) => (
              <View role="listitem" key={batch.id} className={index === 0 ? '' : 'border-t border-divider'}>
                <Link href={`/wardrobe/uploads/${batch.id}`} className="min-h-target px-4 py-3 hover:bg-surface-subtle">
                  <RNText className="text-body text-accent">
                    {`${batch.entry_count} ${batch.entry_count === 1 ? 'photo' : 'photos'} · ${formatDateTime(batch.created_at)}`}
                  </RNText>
                </Link>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
