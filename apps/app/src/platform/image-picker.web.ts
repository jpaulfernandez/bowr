export type PickedImage = { file: File; name: string; type: string; size: number };

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';

/** Some browsers report HEIC files with an empty type; fall back to the extension. */
function declaredType(file: File): string {
  if (file.type) return file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  if (/\.hei[cf]$/i.test(file.name)) return 'image/heic';
  return '';
}

/**
 * Opens the browser file picker. With `capture`, phones may offer the camera; if
 * the camera is denied or absent, the browser still offers the file picker.
 */
export function pickImages({ capture }: { capture: boolean }): Promise<PickedImage[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = !capture;
    if (capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    const finish = (files: File[]) => {
      input.remove();
      resolve(files.map((file) => ({ file, name: file.name, type: declaredType(file), size: file.size })));
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
