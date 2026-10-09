import fs from 'node:fs';
import path from 'node:path';
import { verifyUrlSig } from '../utils/crypto.js';
import { forbidden, notFound, badRequest } from '../utils/errors.js';

export const imageController = (svc) => ({
  uploadUrl: async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await svc.images.createUpload(req.user, req.body));
  },
  upload: async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Empty body or unsupported content type');
    res.json(await svc.images.receiveUpload(req.user, req.params.id, req.body, req.headers['content-type']));
  },
  complete: async (req, res) => res.json(await svc.images.complete(req.user, req.params.id)),
  status: async (req, res) => {
    const m = await svc.images.publicMeta(req.params.id);
    if (!m) throw notFound('Image not found');
    res.json(m);
  },
  view: async (req, res) => {
    res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' });
    res.json(await svc.images.view(req.user, req.params.id));
  },
  /** Local (dry-run) storage delivery. Real providers serve through their own signed URLs. */
  blob: async (req, res) => {
    const key = decodeURI(req.params[0] || '');
    const { exp, sig } = req.query;
    if (!verifyUrlSig(`/blob/${key}`, exp, '', sig)) throw forbidden('Link expired');
    if (svc.storage.name !== 'local' || !/^(proc|evidence)\//.test(key)) throw notFound('Not found');
    const file = path.resolve(svc.storage.dir, key);
    if (!file.startsWith(svc.storage.dir + path.sep) || !fs.existsSync(file)) throw notFound('Not found');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    fs.createReadStream(file).pipe(res);
  },
});
