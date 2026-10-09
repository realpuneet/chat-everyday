import { config } from '../../config/env.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import { ImageKitStorage } from './imagekit.js';
import { logger } from '../../config/logger.js';

/**
 * StorageAdapter interface (all async):
 *   putObject(key, buffer, {contentType}) · getObject(key) · headObject(key)->{size}|null · deleteObject(key)
 *   copyObject(src, dst) · getSignedGetUrl(key, ttlSec) · createDirectUpload(key, {contentType,size,ttlSec})->{url,method,headers}|null
 * Missing credentials => local DRY-RUN disk storage.
 */
export function createStorage(cfg = config) {
  if (cfg.STORAGE_PROVIDER === 's3') {
    if (cfg.S3_BUCKET && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY) {
      return new S3Storage({ endpoint: cfg.S3_ENDPOINT, region: cfg.S3_REGION, bucket: cfg.S3_BUCKET, accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY, forcePathStyle: cfg.S3_FORCE_PATH_STYLE });
    }
    logger.warn('STORAGE_PROVIDER=s3 but credentials are blank: falling back to local DRY-RUN storage');
  }
  if (cfg.STORAGE_PROVIDER === 'imagekit') {
    if (cfg.IMAGEKIT_PUBLIC_KEY && cfg.IMAGEKIT_PRIVATE_KEY && cfg.IMAGEKIT_URL_ENDPOINT) {
      return new ImageKitStorage({ publicKey: cfg.IMAGEKIT_PUBLIC_KEY, privateKey: cfg.IMAGEKIT_PRIVATE_KEY, urlEndpoint: cfg.IMAGEKIT_URL_ENDPOINT });
    }
    logger.warn('STORAGE_PROVIDER=imagekit but credentials are blank: falling back to local DRY-RUN storage');
  }
  return new LocalStorage({ dir: cfg.LOCAL_STORAGE_DIR, publicUrl: cfg.PUBLIC_URL });
}
