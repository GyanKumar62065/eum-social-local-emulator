import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
export interface BlobStore { get(bucket: string, key: string): Promise<{ bytes: Uint8Array; contentType?: string }>; put(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void> }
export function s3BlobStore(endpoint: string, region: string): BlobStore {
  const s3 = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 })
  return {
    async get(bucket, key) { const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return { bytes: await result.Body!.transformToByteArray(), contentType: result.ContentType } },
    async put(bucket, key, bytes, contentType) { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType })) },
  }
}
export function noBlobStore(): BlobStore {
  const unavailable = async (): Promise<never> => { throw new Error('S3 is unavailable because no aws.endpoint is configured') }
  return { get: unavailable, put: unavailable }
}
export interface MemoryBlobStore extends BlobStore { objects: Map<string, { bytes: Uint8Array; contentType?: string }> }
export function memoryBlobStore(): MemoryBlobStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  return {
    objects,
    async get(bucket, key) { const object = objects.get(`${bucket}/${key}`); if (!object) throw new Error(`NoSuchKey: ${bucket}/${key}`); return object },
    async put(bucket, key, bytes, contentType) { objects.set(`${bucket}/${key}`, { bytes, contentType }) },
  }
}
