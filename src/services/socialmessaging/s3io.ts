import type { Ctx } from '../../context.ts'
import { invalid } from '../../smithy/errors.ts'
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  pdf: 'application/pdf', text: 'text/plain', txt: 'text/plain',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', '3gp': 'video/3gp', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac', amr: 'audio/amr',
}
export const guessMime = (name: string): string => MIME[name.split('?')[0].split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
export async function readS3(ctx: Ctx, file: { bucketName: string; key: string }): Promise<{ bytes: Uint8Array; mimeType: string }> {
  try { const object = await ctx.blobStore.get(file.bucketName, file.key); return { bytes: object.bytes, mimeType: object.contentType ?? guessMime(file.key) } }
  catch (error) { throw invalid(`Could not read s3://${file.bucketName}/${file.key}: ${reason(error)}`) }
}
export async function writeS3(ctx: Ctx, file: { bucketName: string; key: string }, bytes: Uint8Array, mimeType: string): Promise<void> {
  try { await ctx.blobStore.put(file.bucketName, file.key, bytes, mimeType) }
  catch (error) { throw invalid(`Could not write s3://${file.bucketName}/${file.key}: ${reason(error)}`) }
}
