/** Native camera and library adapters arrive in phase 8. */
export type PickedImage = { file: File; name: string; type: string; size: number };

export async function pickImages(_options: { capture: boolean }): Promise<PickedImage[]> {
  return [];
}
