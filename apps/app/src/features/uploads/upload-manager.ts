// In-memory upload transport for the current tab. Files never leave memory except
// through their signed PUT; a closed tab loses unsent files, and the receipt says so.
import { CompletedEntry, RenewedUpload, type SignedUpload, type UploadSlot } from '@bowr/contracts';
import { useSyncExternalStore } from 'react';
import { onAccountDispose } from '../../lib/account-lifecycle';
import { apiRequest } from '../../lib/api';

export type LocalStatus = 'queued' | 'uploading' | 'completing' | 'done' | 'failed';
export type LocalUpload = { entryId: string; name: string; status: LocalStatus; progress: number; error?: string };

type Task = LocalUpload & { file: File; upload: SignedUpload | null; completeKey: string; xhr?: XMLHttpRequest };

const MAX_CONCURRENT = 3;
const tasks = new Map<string, Task>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, LocalUpload> = new Map();

function emit() {
  snapshot = new Map(Array.from(tasks, ([id, { file: _file, upload: _upload, xhr: _xhr, completeKey: _key, ...pub }]) => [id, pub]));
  for (const listener of listeners) listener();
}

function update(entryId: string, patch: Partial<Task>) {
  const task = tasks.get(entryId);
  if (!task) return;
  Object.assign(task, patch);
  emit();
}

function put(task: Task, upload: SignedUpload): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open('PUT', upload.url);
    for (const [name, value] of Object.entries(upload.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) update(task.entryId, { progress: event.loaded / event.total });
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(task.file);
  });
}

async function run(task: Task) {
  try {
    update(task.entryId, { status: 'uploading', progress: 0, error: undefined });
    let upload = task.upload;
    if (!upload || Date.parse(upload.expires_at) - Date.now() < 30_000) {
      upload = (await apiRequest(`/upload-entries/${task.entryId}/renew`, {
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        schema: RenewedUpload,
      })).upload;
      task.upload = upload;
    }
    await put(task, upload);
    update(task.entryId, { status: 'completing', progress: 1 });
    // The same request identity is reused if completion must be retried.
    await apiRequest(`/upload-entries/${task.entryId}/complete`, {
      method: 'POST',
      idempotencyKey: task.completeKey,
      schema: CompletedEntry,
    });
    update(task.entryId, { status: 'done' });
  } catch (error) {
    if (!tasks.has(task.entryId)) return;
    update(task.entryId, { status: 'failed', error: (error as Error).message });
  } finally {
    task.xhr = undefined;
    pump();
  }
}

function pump() {
  const active = Array.from(tasks.values()).filter((t) => t.status === 'uploading' || t.status === 'completing').length;
  const next = Array.from(tasks.values()).filter((t) => t.status === 'queued').slice(0, Math.max(0, MAX_CONCURRENT - active));
  for (const task of next) void run(task);
}

export const uploadManager = {
  start(slots: UploadSlot[], files: Map<string, { file: File; name: string }>) {
    for (const slot of slots) {
      const picked = files.get(slot.client_file_id);
      if (!picked || slot.state !== 'awaiting_upload') continue;
      tasks.set(slot.entry_id, {
        entryId: slot.entry_id,
        name: picked.name,
        file: picked.file,
        upload: slot.upload,
        completeKey: crypto.randomUUID(),
        status: 'queued',
        progress: 0,
      });
    }
    emit();
    pump();
  },
  retry(entryId: string) {
    const task = tasks.get(entryId);
    if (task && task.status === 'failed') {
      update(entryId, { status: 'queued' });
      pump();
    }
  },
  forget(entryId: string) {
    tasks.get(entryId)?.xhr?.abort();
    tasks.delete(entryId);
    emit();
  },
  reset() {
    for (const task of tasks.values()) task.xhr?.abort();
    tasks.clear();
    emit();
  },
};

onAccountDispose(() => uploadManager.reset());

export function useLocalUploads(): ReadonlyMap<string, LocalUpload> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
