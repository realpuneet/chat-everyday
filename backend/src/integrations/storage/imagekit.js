import crypto from 'node:crypto';

/**
 * ImageKit adapter (optional). Files are uploaded as PRIVATE (`isPrivateFile`) and served through
 * signed URLs (`ik-s` / `ik-t`). Uploads are proxied through the API (ImageKit has no browser-direct private upload
 * without a server-generated signature, and we want EXIF stripped before anything is stored).
 * NOTE: read ImageKit's acceptable-use policy about adult content BEFORE enabling this provider.
 */
export class ImageKitStorage {
  constructor({ publicKey, privateKey, urlEndpoint }) {
    this.name = 'imagekit';
    this.dryRun = false;
    this.supportsDirectUpload = false;
    Object.assign(this, { publicKey, privateKey, urlEndpoint: urlEndpoint.replace(/\/$/, '') });
    this.auth = `Basic ${Buffer.from(`${privateKey}:`).toString('base64')}`;
  }

  #split(key) {
    const i = key.lastIndexOf('/');
    return { folder: `/chat-everyday/${key.slice(0, i)}`, name: key.slice(i + 1).replace(/[^A-Za-z0-9._-]/g, '_') };
  }

  async putObject(key, buffer) {
    const { folder, name } = this.#split(key);
    const form = new FormData();
    form.set('file', new Blob([buffer]), name);
    form.set('fileName', name);
    form.set('folder', folder);
    form.set('useUniqueFileName', 'false');
    form.set('isPrivateFile', 'true');
    const r = await fetch('https://upload.imagekit.io/api/v1/files/upload', { method: 'POST', headers: { authorization: this.auth }, body: form, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`imagekit upload ${r.status}`);
  }

  async #fileId(key) {
    const { folder, name } = this.#split(key);
    const u = new URL('https://api.imagekit.io/v1/files');
    u.search = new URLSearchParams({ path: folder, searchQuery: `name="${name}"` }).toString();
    const r = await fetch(u, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const list = await r.json();
    return list[0]?.fileId ?? null;
  }

  /** Signed URL per ImageKit docs: signature = HMAC-SHA1(privateKey, url + expiry). */
  signUrl(path, ttlSec, now = Date.now()) {
    const expire = Math.floor(now / 1000) + ttlSec;
    const url = `${this.urlEndpoint}${path}`;
    const sig = crypto.createHmac('sha1', this.privateKey).update(url + expire).digest('hex');
    return `${url}?ik-t=${expire}&ik-s=${sig}`;
  }

  async getSignedGetUrl(key, ttlSec) {
    const { folder, name } = this.#split(key);
    return this.signUrl(`${folder}/${name}`, ttlSec);
  }
  async getObject(key) {
    const r = await fetch(await this.getSignedGetUrl(key, 60), { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`imagekit get ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async headObject(key) {
    return (await this.#fileId(key)) ? { size: 0 } : null;
  }
  async deleteObject(key) {
    const id = await this.#fileId(key);
    if (id) await fetch(`https://api.imagekit.io/v1/files/${id}`, { method: 'DELETE', headers: { authorization: this.auth }, signal: AbortSignal.timeout(10000) });
  }
  async copyObject(src, dst) {
    await this.putObject(dst, await this.getObject(src));
  }
  async createDirectUpload() {
    return null;
  }
}
