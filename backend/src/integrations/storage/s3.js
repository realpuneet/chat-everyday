import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze...). The bucket MUST be private.
 * Objects are only ever reachable through short-lived presigned GET URLs.
 */
export class S3Storage {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }) {
    this.name = 's3';
    this.dryRun = false;
    this.supportsDirectUpload = true;
    this.bucket = bucket;
    this.client = new S3Client({ endpoint: endpoint || undefined, region: region || 'auto', forcePathStyle, credentials: { accessKeyId, secretAccessKey } });
  }

  async putObject(key, buffer, { contentType = 'application/octet-stream' } = {}) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: contentType, CacheControl: 'no-store' }));
  }
  async getObject(key) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async headObject(key) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength };
    } catch {
      return null;
    }
  }
  async deleteObject(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async copyObject(src, dst) {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: dst, CopySource: `${this.bucket}/${src}` }));
  }
  async getSignedGetUrl(key, ttlSec) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseCacheControl: 'no-store', ResponseContentType: 'image/jpeg' }), { expiresIn: ttlSec });
  }
  /** Presigned PUT bound to the declared content type + exact size. */
  async createDirectUpload(key, { contentType, size, ttlSec = 300 }) {
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size, CacheControl: 'no-store' }), { expiresIn: ttlSec });
    return { url, method: 'PUT', headers: { 'content-type': contentType } };
  }
}
