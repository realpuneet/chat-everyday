import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { S3Storage } from '../../src/integrations/storage/s3.js';
import { ImageKitStorage } from '../../src/integrations/storage/imagekit.js';
import { LocalStorage } from '../../src/integrations/storage/local.js';
import { createStorage } from '../../src/integrations/storage/index.js';
import { loadConfig } from '../../src/config/env.js';
import { dHash, hamming } from '../../src/utils/phash.js';
import { verifyUrlSig } from '../../src/utils/crypto.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-storage-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('storage adapters', () => {
  it('falls back to local DRY-RUN storage when credentials are blank', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', STORAGE_PROVIDER: 's3' });
    expect(createStorage(cfg).name).toBe('local');
    expect(createStorage(loadConfig({ NODE_ENV: 'test', STORAGE_PROVIDER: 'imagekit' })).name).toBe('local');
    expect(createStorage(loadConfig({ NODE_ENV: 'test' })).dryRun).toBe(true);
  });

  it('selects S3 / ImageKit when configured', () => {
    expect(createStorage(loadConfig({ NODE_ENV: 'test', STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://localhost:9000' })).name).toBe('s3');
    expect(createStorage(loadConfig({ NODE_ENV: 'test', STORAGE_PROVIDER: 'imagekit', IMAGEKIT_PUBLIC_KEY: 'p', IMAGEKIT_PRIVATE_KEY: 'k', IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/x' })).name).toBe('imagekit');
  });

  it('S3 presigned URLs are short-lived, private, signed and bind content type + length', async () => {
    const s3 = new S3Storage({ endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'priv', accessKeyId: 'AKIA', secretAccessKey: 'secret', forcePathStyle: true });
    const get = new URL(await s3.getSignedGetUrl('proc/abc.jpg', 45));
    expect(get.pathname).toBe('/priv/proc/abc.jpg');
    expect(get.searchParams.get('X-Amz-Expires')).toBe('45');
    expect(get.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(get.searchParams.get('response-cache-control')).toBe('no-store');
    const up = await s3.createDirectUpload('tmp/abc', { contentType: 'image/jpeg', size: 1234, ttlSec: 300 });
    expect(up.method).toBe('PUT');
    expect(new URL(up.url).searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-length/);
    expect(up.headers['content-type']).toBe('image/jpeg');
  });

  it('ImageKit signed URLs follow HMAC-SHA1(privateKey, url + expiry)', () => {
    const ik = new ImageKitStorage({ publicKey: 'pub', privateKey: 'private_key', urlEndpoint: 'https://ik.imagekit.io/demo/' });
    const now = 1_700_000_000_000;
    const signed = new URL(ik.signUrl('/chat-everyday/proc/a.jpg', 45, now));
    const expire = 1_700_000_045;
    expect(signed.searchParams.get('ik-t')).toBe(String(expire));
    const expected = crypto.createHmac('sha1', 'private_key').update(`https://ik.imagekit.io/demo/chat-everyday/proc/a.jpg${expire}`).digest('hex');
    expect(signed.searchParams.get('ik-s')).toBe(expected);
  });

  it('local storage round-trips, refuses path traversal and signs short-lived URLs', async () => {
    const st = new LocalStorage({ dir: tmp, publicUrl: 'http://x' });
    await st.putObject('proc/a.jpg', Buffer.from('hi'));
    expect((await st.getObject('proc/a.jpg')).toString()).toBe('hi');
    expect((await st.headObject('proc/a.jpg')).size).toBe(2);
    await st.copyObject('proc/a.jpg', 'evidence/r/a.jpg');
    expect((await st.getObject('evidence/r/a.jpg')).toString()).toBe('hi');
    await expect(st.getObject('../../etc/passwd')).rejects.toThrow();
    await expect(st.putObject('../evil', Buffer.from('x'))).rejects.toThrow();
    const url = new URL(await st.getSignedGetUrl('proc/a.jpg', 30));
    expect(verifyUrlSig('/blob/proc/a.jpg', url.searchParams.get('exp'), '', url.searchParams.get('sig'))).toBe(true);
    expect(verifyUrlSig('/blob/proc/b.jpg', url.searchParams.get('exp'), '', url.searchParams.get('sig'))).toBe(false);
    await st.deleteObject('proc/a.jpg');
    expect(await st.headObject('proc/a.jpg')).toBe(null);
  });
});

describe('perceptual hash', () => {
  const picture = (w, h) =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#223"/><circle cx="${w * 0.3}" cy="${h * 0.4}" r="${h * 0.25}" fill="#f55"/><rect x="${w * 0.6}" y="${h * 0.5}" width="${w * 0.3}" height="${h * 0.4}" fill="#5af"/></svg>`));
  it('is stable under resize + recompression and differs for other pictures', async () => {
    const a = await picture(800, 600).jpeg().toBuffer();
    const resized = await sharp(a).resize(300).jpeg({ quality: 50 }).toBuffer();
    const other = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
    const [ha, hr, ho] = await Promise.all([dHash(a), dHash(resized), dHash(other)]);
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(ha, hr)).toBeLessThanOrEqual(6);
    expect(hamming(ha, ha)).toBe(0);
    expect(hamming(ha, ho)).toBeGreaterThan(0);
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });
});
