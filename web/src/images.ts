// Pictures people add from their own device. They are shrunk here, before they
// are sent, so a 12-megapixel phone photo goes up as a few hundred KB.

import { api } from './api.ts';

const LONGEST_SIDE = 1600;

async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture this browser can read.');
  });
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  // JPEG has no transparency; a cut-out product shot goes on white, not black.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Uploads a picture to the list and returns the path an image cell holds for it. */
export async function uploadImage(listId: string, file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a picture.');
  const result = await api.uploadImage(listId, await shrink(file));
  return result!.path;
}

/** The first picture in a paste or a drop, if there is one. */
export function pictureIn(data: DataTransfer | null): File | undefined {
  return [...(data?.files ?? [])].find((f) => f.type.startsWith('image/'));
}
