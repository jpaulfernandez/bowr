import { MediaGrants, type Item } from '@bowr/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { View } from 'react-native';
import { z } from 'zod';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { RadioGroup } from '../../components/RadioGroup';
import { Heading, Text } from '../../components/Text';
import { TextField } from '../../components/TextField';
import { apiRequest } from '../../lib/api';
import { ApiError } from '../../lib/errors';
import { userKeys } from '../../lib/query-keys';
import { useSession } from '../../lib/session';
import { assetFor } from './queries';

type Tool = 'erase' | 'restore';
const SIZES = { small: 8, medium: 24, large: 56 } as const;
type Size = keyof typeof SIZES;
const ZOOMS = { '1': 1, '2': 2, '4': 4 } as const;
type Zoom = keyof typeof ZOOMS;
const HISTORY = 20;
// Removed areas are tinted so the edge is visible over the original.
const TINT = [196, 47, 72, 150] as const;

function useSigned(assetId: string | null, variant: 'original' | 'mask') {
  const { userId } = useSession();
  return useQuery({
    queryKey: [...userKeys.all(userId ?? 'none'), 'media', assetId, variant],
    queryFn: async ({ signal }) =>
      (await apiRequest('/media/access', { method: 'POST', body: { requests: [{ asset_id: assetId, variant }] }, schema: MediaGrants, signal }))[0]!,
    enabled: userId !== null && assetId !== null,
    staleTime: 4 * 60_000,
  });
}

const Submitted = z.object({ media_revision: z.number().int(), job_id: z.string().uuid() });

/**
 * Edge correction (DESIGN 6.4): Restore / Erase with a brush, brush size, zoom,
 * undo and reset, plus an area tool that needs no drawing. Only the edited mask
 * is sent; the server composes the new cutout from the stored original, which
 * stays available throughout.
 */
export function MaskEditor({ item, onDone }: { item: Item; onDone: () => void }) {
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const originalAsset = assetFor(item, 'original');
  const maskAsset = assetFor(item, 'mask');
  const original = useSigned(originalAsset?.asset_id ?? null, 'original');
  // A mask from an earlier photo does not fit this one; editing then starts from "keep everything".
  const usableMask = maskAsset && originalAsset && maskAsset.media_revision >= originalAsset.media_revision ? maskAsset : null;
  const mask = useSigned(usableMask?.asset_id ?? null, 'mask');
  const width = original.data?.status === 'ok' ? original.data.width : 0;
  const height = original.data?.status === 'ok' ? original.data.height : 0;

  const maskCanvas = useRef<HTMLCanvasElement | null>(null);
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const initial = useRef<ImageData | null>(null);
  const history = useRef<ImageData[]>([]);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [tool, setTool] = useState<Tool>('erase');
  const [size, setSize] = useState<Size>('medium');
  const [zoom, setZoom] = useState<Zoom>('1');
  const [area, setArea] = useState({ left: '0', top: '0', width: '20', height: '20' });
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef<string | null>(null);

  /** Recomputes the tint from the mask: exact after every operation. */
  const repaint = useCallback(() => {
    const source = maskCanvas.current?.getContext('2d');
    const target = overlay.current?.getContext('2d');
    if (!source || !target || !width) return;
    const pixels = source.getImageData(0, 0, width, height).data;
    const tint = target.createImageData(width, height);
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! < 128) tint.data.set(TINT, i);
    }
    target.putImageData(tint, 0, 0);
  }, [width, height]);

  // Load the current mask (or start with everything kept) once the sizes are known.
  useEffect(() => {
    if (!width || !original.data || (usableMask && !mask.data)) return;
    let cancelled = false;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const finish = () => {
      if (cancelled) return;
      maskCanvas.current = canvas;
      initial.current = context.getImageData(0, 0, width, height);
      setReady(true);
    };
    const url = mask.data?.status === 'ok' && mask.data.width === width && mask.data.height === height ? mask.data.url : null;
    if (!url) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      finish();
    } else {
      fetch(url)
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('mask'))))
        .then((blob) => createImageBitmap(blob))
        .then((bitmap) => {
          context.drawImage(bitmap, 0, 0, width, height);
          finish();
        })
        .catch(() => !cancelled && setLoadError(true));
    }
    return () => {
      cancelled = true;
    };
  }, [width, height, original.data, mask.data, usableMask]);

  useEffect(() => {
    if (ready) repaint();
  }, [ready, repaint]);

  const snapshot = () => {
    const context = maskCanvas.current!.getContext('2d')!;
    history.current = [...history.current.slice(-(HISTORY - 1)), context.getImageData(0, 0, width, height)];
    setUndoCount(history.current.length);
  };

  const paint = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const context = maskCanvas.current!.getContext('2d')!;
    context.strokeStyle = context.fillStyle = tool === 'erase' ? '#000' : '#fff';
    context.lineWidth = SIZES[size];
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    // Quick feedback while drawing; the exact tint is recomputed at the end.
    const view = overlay.current!.getContext('2d')!;
    view.globalCompositeOperation = tool === 'erase' ? 'source-over' : 'destination-out';
    view.strokeStyle = `rgba(${TINT[0]}, ${TINT[1]}, ${TINT[2]}, ${TINT[3] / 255})`;
    view.lineWidth = SIZES[size];
    view.lineCap = 'round';
    view.beginPath();
    view.moveTo(from.x, from.y);
    view.lineTo(to.x, to.y);
    view.stroke();
    view.globalCompositeOperation = 'source-over';
  };

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * width, y: ((event.clientY - rect.top) / rect.height) * height };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    snapshot();
    const at = point(event);
    drawing.current = at;
    paint(at, at);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const at = point(event);
    paint(drawing.current, at);
    drawing.current = at;
  };
  const onPointerUp = () => {
    if (!drawing.current) return;
    drawing.current = null;
    repaint();
  };

  const applyArea = (mode: Tool) => {
    const [l, t, w, h] = [area.left, area.top, area.width, area.height].map((v) => Number(v.replace(',', '.')) / 100);
    if ([l, t, w, h].some((v) => !Number.isFinite(v!)) || l! < 0 || t! < 0 || w! <= 0 || h! <= 0 || l! + w! > 1.0001 || t! + h! > 1.0001) {
      setNotice('Check the area: it must fit inside the photo.');
      return;
    }
    setNotice(null);
    snapshot();
    const context = maskCanvas.current!.getContext('2d')!;
    context.fillStyle = mode === 'erase' ? '#000' : '#fff';
    context.fillRect(Math.round(l! * width), Math.round(t! * height), Math.round(w! * width), Math.round(h! * height));
    repaint();
  };

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    maskCanvas.current!.getContext('2d')!.putImageData(previous, 0, 0);
    setUndoCount(history.current.length);
    repaint();
  };
  const reset = () => {
    if (!initial.current) return;
    snapshot();
    maskCanvas.current!.getContext('2d')!.putImageData(initial.current, 0, 0);
    repaint();
  };

  const save = useMutation({
    mutationFn: async () => {
      const blob = await new Promise<Blob>((resolve, reject) =>
        maskCanvas.current!.toBlob((b) => (b ? resolve(b) : reject(new Error('mask'))), 'image/png'),
      );
      request.current ??= crypto.randomUUID();
      return apiRequest(`/items/${item.id}/mask?media_revision=${item.media_revision}`, {
        method: 'POST',
        body: blob,
        idempotencyKey: request.current,
        schema: Submitted,
      });
    },
    onSuccess: () => {
      if (userId) void queryClient.invalidateQueries({ queryKey: userKeys.all(userId) });
      onDone();
    },
    onError: (error) => {
      request.current = null;
      setNotice(error instanceof ApiError ? error.message : "The edges weren't saved. Try again.");
    },
  });

  if (!originalAsset) return <Banner tone="warning" message="This piece has no photo to edit yet." />;
  if (loadError || original.data?.status === 'not_found') {
    return <Banner tone="error" message="The photo couldn't be loaded for editing. Use the other options on the piece instead." />;
  }
  const display = Math.min(560, typeof window === 'undefined' ? 560 : window.innerWidth - 48) * ZOOMS[zoom];
  const displayHeight = width ? (display * height) / width : display;

  return (
    <View className="gap-4">
      <Text variant="secondary">
        Draw over the photo to erase background or restore parts of the piece. Tinted areas are removed. If drawing is hard, use the area
        fields below, or go back and use the original photo, try the other cutout model, or replace the photo.
      </Text>
      <View className="flex-row flex-wrap gap-6">
        <RadioGroup
          label="Brush"
          value={tool}
          options={[
            { value: 'erase', label: 'Erase' },
            { value: 'restore', label: 'Restore' },
          ]}
          onChange={setTool}
        />
        <RadioGroup
          label="Brush size"
          value={size}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
          onChange={setSize}
        />
        <RadioGroup
          label="Zoom"
          value={zoom}
          options={[
            { value: '1', label: '100%' },
            { value: '2', label: '200%' },
            { value: '4', label: '400%' },
          ]}
          onChange={setZoom}
        />
      </View>
      <div style={{ maxWidth: '100%', maxHeight: '70vh', overflow: 'auto' }} className="rounded-image border border-divider">
        <div style={{ position: 'relative', width: display, height: displayHeight }}>
          {original.data?.status === 'ok' ? (
            <img src={original.data.url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
          ) : null}
          <canvas
            ref={overlay}
            width={width || 1}
            height={height || 1}
            role="img"
            aria-label={`${ready ? 'Edge editing area' : 'Loading the photo'}. Tinted areas are removed from the cutout.`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'crosshair' }}
          />
        </div>
      </div>
      <View className="flex-row flex-wrap gap-2">
        <Button label="Undo" variant="secondary" disabled={undoCount === 0} onPress={undo} />
        <Button label="Reset edges" variant="secondary" disabled={!ready} onPress={reset} />
      </View>
      <View className="max-w-prose gap-3 rounded-control border border-divider bg-surface p-3">
        <Heading level={2}>Edit an area without drawing</Heading>
        <View className="flex-row flex-wrap gap-3">
          {(
            [
              ['left', 'From left (%)'],
              ['top', 'From top (%)'],
              ['width', 'Width (%)'],
              ['height', 'Height (%)'],
            ] as const
          ).map(([field, label]) => (
            <View key={field} className="w-[120px]">
              <TextField label={label} value={area[field]} inputMode="decimal" onChangeText={(value) => setArea({ ...area, [field]: value })} />
            </View>
          ))}
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Button label="Erase this area" variant="secondary" disabled={!ready} onPress={() => applyArea('erase')} />
          <Button label="Restore this area" variant="secondary" disabled={!ready} onPress={() => applyArea('restore')} />
        </View>
      </View>
      {notice ? <Banner tone="error" message={notice} /> : null}
      <View className="flex-row flex-wrap gap-3">
        <Button label="Save edges" disabled={!ready} busy={save.isPending} busyLabel="Saving edges" onPress={() => save.mutate()} />
        <Button label="Cancel" variant="quiet" onPress={onDone} />
      </View>
    </View>
  );
}
