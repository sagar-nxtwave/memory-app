import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3'

const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: process.env.MINIO_REGION ?? 'us-east-005',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: false,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const BUCKET = process.env.MINIO_BUCKET ?? 'Memory-H'

await client.send(new PutBucketCorsCommand({
  Bucket: BUCKET,
  CORSConfiguration: {
    CORSRules: [
      {
        AllowedOrigins: [
          'https://sagar-memory-app.vercel.app',
          'http://localhost:3000',
        ],
        AllowedMethods: ['PUT', 'GET', 'HEAD', 'DELETE'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      },
    ],
  },
}))

console.log('CORS rules set successfully on bucket:', BUCKET)
