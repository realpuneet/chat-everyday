import fs from 'node:fs/promises';
import path from 'node:path';
import { signUrlParams } from '../../utils/crypto.js';

/** DRY-RUN storage: files on local disk, delivery through our own signed `/api/images/blob/*` route. */
export class LocalStorage {
  constructor({ dir, publicUrl }) {
    this.name = 'local';
    this.dryRun = true;
    this.supportsDirectUpload = false;
    this.dir = path.resolve(dir);
    this.publicUrl = publicUrl;
  }

  #path(key) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(this.dir + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async putObject(key, buffer) {
    const p = this.#path(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buffer, { mode: 0o600 });
  }
  async getObject(key) {
    return fs.readFile(this.#path(key));
  }
  async headObject(key) {
    try {
      const s = await fs.stat(this.#path(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }
  async deleteObject(key) {
    await fs.rm(this.#path(key), { force: true });
  }
  async copyObject(src, dst) {
    await this.putObject(dst, await this.getObject(src));
  }
  async getSignedGetUrl(key, ttlSec) {
    const exp = Date.now() + ttlSec * 1000;
    const sig = signUrlParams(`/blob/${key}`, exp);
    return `${this.publicUrl}/api/images/blob/${encodeURI(key)}?exp=${exp}&sig=${sig}`;
  }
  async createDirectUpload() {
    return null; // uploads are proxied through the API
  }
}
