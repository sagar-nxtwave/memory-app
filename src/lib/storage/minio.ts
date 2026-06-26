import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'

const BUCKET = process.env.MINIO_BUCKET ?? 'memory-docs'

// Universal S3 client — works with MinIO (local), Backblaze B2, Cloudflare R2, AWS S3.
// Switch providers by changing env vars only — no code changes needed.
export const s3Client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY!,
    secretAccessKey: process.env.MINIO_SECRET_KEY!,
  },
  // Required for MinIO — path-style URLs (localhost:9000/bucket/key)
  // Set to false for Backblaze B2 / Cloudflare R2 / AWS S3
  forcePathStyle: process.env.MINIO_FORCE_PATH_STYLE !== 'false',
})

export async function ensureBucketExists(): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }))
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  }
}

export async function uploadFile(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  await ensureBucketExists()
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  )
  return key
}

export async function getFileBuffer(key: string): Promise<Buffer> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key })
  )
  if (!response.Body) throw new Error('Empty response body from storage')
  // transformToByteArray works in both Node.js and Edge/serverless runtimes
  const bytes = await response.Body.transformToByteArray()
  return Buffer.from(bytes)
}

export async function deleteFile(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

export function generateStorageKey(
  spaceId: string,
  documentId: string,
  fileName: string
): string {
  const ext = fileName.split('.').pop()
  return `spaces/${spaceId}/documents/${documentId}.${ext}`
}
