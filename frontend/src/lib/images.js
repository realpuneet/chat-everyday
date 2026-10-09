import { api, apiUrl, post } from './api.js';
import { getDeviceId, getSlot } from './device.js';
import { useAuth } from './auth.js';

const waiters = new Map();

/** wire.js calls this for every `image:status` push. */
export function resolveImageStatus(p) {
  const w = waiters.get(p.imageId);
  if (w && p.status !== 'processing') {
    waiters.delete(p.imageId);
    w(p);
  }
}

const waitStatus = (imageId, ms = 40_000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(imageId);
      reject(new Error('Image check timed out. Please try again.'));
    }, ms);
    waiters.set(imageId, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

export const REASONS = {
  known_bad: 'This image is not allowed.',
  invalid_image: 'That file is not a valid image.',
  too_large: 'That image is too large.',
  too_big_dimensions: 'That image is too big (dimensions).',
  nsfw_extreme: 'This image violates our content rules.',
  adult_content_not_allowed_here: 'Adult content is only allowed in rooms marked 18+.',
  minor_risk: 'This image is not allowed.',
  processing_failed: 'We could not process that image. Try another one.',
};

/** Downscale / re-encode on the client (saves bandwidth; the server still strips metadata and re-encodes). */
export async function prepareImage(file, { maxDim = 2048, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Only JPEG, PNG or WebP images are supported.');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= maxBytes) {
    const out = { blob: file, width: bmp.width, height: bmp.height, contentType: file.type };
    bmp.close?.();
    return out;
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  let blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (blob && blob.size > maxBytes) blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.6));
  if (!blob || blob.size > maxBytes) throw new Error('That image is too large even after compression.');
  return { blob, width: w, height: h, contentType: 'image/jpeg' };
}

/** upload-url -> PUT -> complete -> wait for the worker's verdict. Resolves with the final status payload. */
export async function uploadImage({ blob, width, height, contentType, scope, scopeId, viewMode, timerSec }) {
  const slot = await post('/api/images/upload-url', { contentType, size: blob.size, width, height, scope, scopeId, ...(viewMode ? { viewMode } : {}), ...(timerSec ? { timerSec } : {}) });
  const verdict = waitStatus(slot.imageId);
  try {
    if (slot.upload.proxied) {
      await api(slot.upload.url, { method: 'PUT', body: blob, headers: { 'content-type': contentType } });
    } else {
      const r = await fetch(slot.upload.url, { method: slot.upload.method, headers: slot.upload.headers, body: blob });
      if (!r.ok) throw new Error('Upload failed');
    }
    await post(`/api/images/${slot.imageId}/complete`, {});
    const final = await verdict;
    if (final.status === 'rejected') throw Object.assign(new Error(REASONS[final.reason] || 'Image was rejected.'), { code: 'IMAGE_REJECTED' });
    return { imageId: slot.imageId, ...final };
  } catch (e) {
    waiters.delete(slot.imageId);
    throw e;
  }
}

/** Fetches a viewing session (signed URL + watermark info) and downloads the bytes into memory. */
export async function fetchImageForView(imageId) {
  const info = await api(`/api/images/${imageId}/view`);
  const url = info.url.startsWith('http') ? info.url : apiUrl(info.url);
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error('This image link expired. Tap to try again.');
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  return { info, bitmap };
}

export const _internals = { getDeviceId, getSlot, useAuth };
