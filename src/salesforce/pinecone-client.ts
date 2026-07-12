// Shared Pinecone client for Salesforce RAG vector storage.
// Free-tier serverless index (2GB) — holds embeddings for ALL indexed Salesforce records.
// Replaces the earlier Neon/pgvector-based salesforce_chunks table, which hit Neon's 512MB
// database size ceiling well before all Salesforce data could be indexed.
import { Pinecone } from '@pinecone-database/pinecone'

let client: Pinecone | null = null

function getClient(): Pinecone {
  if (!client) {
    const apiKey = process.env.PINECONE_API_KEY
    if (!apiKey) throw new Error('PINECONE_API_KEY is not set')
    client = new Pinecone({ apiKey })
  }
  return client
}

const INDEX_NAME = process.env.PINECONE_INDEX_NAME ?? 'sacred-sycamore'
const NAMESPACE = 'salesforce'

export function getSalesforceIndex() {
  return getClient().index(INDEX_NAME).namespace(NAMESPACE)
}

export interface SalesforceVectorMetadata {
  objectName: string
  recordId: string
  content: string
}
