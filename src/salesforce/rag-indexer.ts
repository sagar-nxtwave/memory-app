// Salesforce RAG indexer — pulls records from key objects, flattens each into searchable
// text, embeds them, and upserts into Pinecone (free-tier serverless, 2GB). This is the
// fallback data source for questions the 100+ pre-built tools can't answer (e.g. ad-hoc
// price-range breakdowns, cross-field lookups). Tools remain the fast/reliable path for
// common queries; this exists purely so "the data is there but no tool matches" never
// means "no answer".
//
// Storage note: this previously used Neon/pgvector (salesforce_chunks table), but hit
// Neon's 512MB database size ceiling well before all ~141K target records could be
// indexed (the HNSW vector index alone cost ~3x the raw row size). Moved to Pinecone's
// free serverless tier (2GB) specifically to fit ALL Salesforce data, not a sample.
import { soql } from './client'
import { generateEmbeddings } from '@/lib/ai/provider'
import { db } from '@/lib/db'
import { salesforceIndexRuns } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSalesforceIndex } from './pinecone-client'

export interface IndexableObject {
  objectName: string
  soqlFields: string
  where?: string
  // Safety cap on total records pulled — NOT a real target. Set high to effectively index
  // everything; keyset pagination has no Salesforce-imposed ceiling (unlike OFFSET, capped at 2000).
  maxRecords: number
  toText: (record: Record<string, unknown>) => string
}

// Fields chosen to cover what ad-hoc questions actually ask about: community/building,
// price/amount, status/stage, dates, and the customer/salesperson names.
const INDEXABLE_OBJECTS: IndexableObject[] = [
  {
    objectName: 'Opportunity',
    soqlFields:
      'Id, Name, StageName, Amount, CloseDate, IsWon, IsClosed, Building_Name__c, Building_Community__c, Sales_Room__c, Account.Name, cm_Sales_Person__r.Name, CreatedDate',
    where: "Amount != 1 AND cm_Sales_Person__r.Name != 'Salesforce Admin'",
    maxRecords: 200000,
    toText: (r) =>
      `Opportunity: ${r.Name} | Stage: ${r.StageName} | Amount: AED ${r.Amount ?? 'N/A'} | Close Date: ${r.CloseDate ?? 'N/A'} | Building: ${r.Building_Name__c ?? 'N/A'} | Community: ${r.Building_Community__c ?? 'N/A'} | Bedroom: ${r.Sales_Room__c ?? 'N/A'} | Customer: ${(r.Account as { Name?: string })?.Name ?? 'N/A'} | Sales Person: ${(r.cm_Sales_Person__r as { Name?: string })?.Name ?? 'N/A'} | Won: ${r.IsWon} | Closed: ${r.IsClosed}`,
  },
  {
    objectName: 'Property_Inventory__c',
    soqlFields: 'Id, Name, Building_Community__c, Property_Status__c, Type__c, Selling_Price__c, Property_Usage__c, CreatedDate',
    maxRecords: 200000,
    toText: (r) =>
      `Property: ${r.Name} | Community: ${r.Building_Community__c ?? 'N/A'} | Status: ${r.Property_Status__c ?? 'N/A'} | Type: ${r.Type__c ?? 'N/A'} | Price: AED ${r.Selling_Price__c ?? 'N/A'} | Usage: ${r.Property_Usage__c ?? 'N/A'}`,
  },
  {
    objectName: 'Account',
    soqlFields: 'Id, Name, Type, CreatedDate',
    maxRecords: 200000,
    toText: (r) => `Account: ${r.Name} | Type: ${r.Type ?? 'N/A'}`,
  },
  {
    objectName: 'Case',
    soqlFields: 'Id, CaseNumber, Subject, Status, Origin, Priority, CreatedDate',
    maxRecords: 200000,
    toText: (r) =>
      `Case ${r.CaseNumber}: ${r.Subject ?? 'N/A'} | Status: ${r.Status ?? 'N/A'} | Origin: ${r.Origin ?? 'N/A'} | Priority: ${r.Priority ?? 'N/A'}`,
  },
]

const EMBED_BATCH_SIZE = 200 // generateEmbeddings() sub-batches to 64/request internally; this just batches Pinecone upserts
const SOQL_PAGE_SIZE = 500 // guardrail caps LIMIT at 500 per query
const PINECONE_UPSERT_BATCH = 200 // Pinecone recommends up to 1000/request; keep smaller for reliability

// Formats a Salesforce datetime value as an unquoted SOQL datetime literal.
function toSoqlDatetimeLiteral(value: unknown): string {
  return String(value)
}

/**
 * Pulls ALL records matching the spec via keyset (cursor) pagination on (CreatedDate, Id) —
 * not OFFSET, which Salesforce hard-caps at 2000 regardless of how it's requested. Each page
 * asks for records strictly "older" than the last one seen, so there is no ceiling: this will
 * walk the entire object (bounded only by spec.maxRecords as a runaway-loop safety net).
 */
async function fetchAllRecords(spec: IndexableObject): Promise<Record<string, unknown>[]> {
  const baseWhere = spec.where ? `${spec.where}` : ''
  const allRecords: Record<string, unknown>[] = []
  let cursorDate: string | null = null
  let cursorId: string | null = null
  let page = 0

  while (allRecords.length < spec.maxRecords) {
    page++
    const cursorClause = cursorDate && cursorId
      ? `(CreatedDate < ${cursorDate} OR (CreatedDate = ${cursorDate} AND Id < '${cursorId}'))`
      : ''
    const conditions = [baseWhere, cursorClause].filter(Boolean).join(' AND ')
    const whereClause = conditions ? ` WHERE ${conditions}` : ''
    const query = `SELECT ${spec.soqlFields} FROM ${spec.objectName}${whereClause} ORDER BY CreatedDate DESC, Id DESC LIMIT ${SOQL_PAGE_SIZE}`

    const result = await soql(query)
    if (result.records.length === 0) break

    allRecords.push(...result.records)
    const last = result.records[result.records.length - 1] as { CreatedDate?: unknown; Id?: unknown }
    cursorDate = toSoqlDatetimeLiteral(last.CreatedDate)
    cursorId = String(last.Id ?? '')

    if (page % 10 === 0) {
      console.log(`[rag-indexer]   ${spec.objectName}: fetched ${allRecords.length} records so far (page ${page})...`)
    }

    if (result.records.length < SOQL_PAGE_SIZE) break // fewer than a full page — reached the end
  }

  return allRecords
}

export interface IndexResult {
  objectName: string
  recordsIndexed: number
  status: 'completed' | 'failed'
  error?: string
}

/** Indexes a single object's records into Pinecone. Upsert-by-id naturally overwrites stale data. */
async function indexObject(spec: IndexableObject): Promise<IndexResult> {
  const [run] = await db
    .insert(salesforceIndexRuns)
    .values({ objectName: spec.objectName, status: 'running' })
    .returning()

  try {
    const records = await fetchAllRecords(spec)

    if (records.length === 0) {
      await db
        .update(salesforceIndexRuns)
        .set({ status: 'completed', recordsIndexed: 0, completedAt: new Date() })
        .where(eq(salesforceIndexRuns.id, run.id))
      return { objectName: spec.objectName, recordsIndexed: 0, status: 'completed' }
    }

    const pineconeIndex = getSalesforceIndex()

    // Process batches with controlled concurrency (embed + upsert to Pinecone) instead of
    // strictly sequential — cuts wall-clock time substantially for large objects since each
    // network call is latency-bound, not CPU-bound.
    const CONCURRENT_BATCHES = 8
    const chunks: Record<string, unknown>[][] = []
    for (let i = 0; i < records.length; i += EMBED_BATCH_SIZE) {
      chunks.push(records.slice(i, i + EMBED_BATCH_SIZE))
    }

    let totalIndexed = 0
    for (let i = 0; i < chunks.length; i += CONCURRENT_BATCHES) {
      const group = chunks.slice(i, i + CONCURRENT_BATCHES)
      const groupResults = await Promise.all(
        group.map(async (batch) => {
          const texts = batch.map((r) => spec.toText(r))
          const embeddings = await generateEmbeddings(texts)
          return batch.map((r, idx) => ({
            id: String(r.Id ?? ''),
            values: embeddings[idx],
            metadata: {
              objectName: spec.objectName,
              recordId: String(r.Id ?? ''),
              content: texts[idx],
            },
          }))
        })
      )

      const vectors = groupResults.flat().filter((v) => v.values && v.values.length > 0)

      // Upsert to Pinecone in sub-batches (recommended limit ~1000/request; we use smaller for reliability)
      for (let j = 0; j < vectors.length; j += PINECONE_UPSERT_BATCH) {
        const upsertBatch = vectors.slice(j, j + PINECONE_UPSERT_BATCH)
        if (upsertBatch.length > 0) {
          await pineconeIndex.upsert({ records: upsertBatch })
        }
      }

      totalIndexed += vectors.length
      console.log(`[rag-indexer]   ${spec.objectName}: embedded+upserted ${totalIndexed}/${records.length}...`)
    }

    await db
      .update(salesforceIndexRuns)
      .set({ status: 'completed', recordsIndexed: totalIndexed, completedAt: new Date() })
      .where(eq(salesforceIndexRuns.id, run.id))

    return { objectName: spec.objectName, recordsIndexed: totalIndexed, status: 'completed' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await db
      .update(salesforceIndexRuns)
      .set({ status: 'failed', error, completedAt: new Date() })
      .where(eq(salesforceIndexRuns.id, run.id))
    return { objectName: spec.objectName, recordsIndexed: 0, status: 'failed', error }
  }
}

/** Indexes all configured objects (or a filtered subset). Runs sequentially to stay within embedding API rate limits. */
export async function indexAllSalesforceData(objectNames?: string[]): Promise<IndexResult[]> {
  const specs = objectNames ? INDEXABLE_OBJECTS.filter((s) => objectNames.includes(s.objectName)) : INDEXABLE_OBJECTS
  const results: IndexResult[] = []
  for (const spec of specs) {
    console.log(`[rag-indexer] indexing ${spec.objectName}...`)
    const result = await indexObject(spec)
    console.log(`[rag-indexer] ${spec.objectName}: ${result.status} (${result.recordsIndexed} records)`)
    results.push(result)
  }
  return results
}

/** Returns freshness info — how many chunks exist and when they were last indexed, per object (from Pinecone index stats). */
export async function getIndexStatus(): Promise<{ objectName: string; count: number; lastIndexedAt: Date | null }[]> {
  const runs = await db
    .select({
      objectName: salesforceIndexRuns.objectName,
      recordsIndexed: salesforceIndexRuns.recordsIndexed,
      completedAt: salesforceIndexRuns.completedAt,
      status: salesforceIndexRuns.status,
    })
    .from(salesforceIndexRuns)

  // Latest completed run per object
  const latest = new Map<string, { count: number; lastIndexedAt: Date | null }>()
  for (const r of runs) {
    if (r.status !== 'completed') continue
    const existing = latest.get(r.objectName)
    if (!existing || (r.completedAt && (!existing.lastIndexedAt || r.completedAt > existing.lastIndexedAt))) {
      latest.set(r.objectName, { count: r.recordsIndexed ?? 0, lastIndexedAt: r.completedAt })
    }
  }

  return Array.from(latest.entries()).map(([objectName, v]) => ({ objectName, ...v }))
}

// ─────────────────────────────────────────────────────────────────────────────
// FUTURE: incremental sync design (NOT implemented yet — full re-index only, for now)
// ─────────────────────────────────────────────────────────────────────────────
// Once full indexing is stable, replace the manual full re-index with incremental sync so
// re-running doesn't re-embed unchanged records every time:
//
// 1. Each object already gets a `salesforceIndexRuns.completedAt` timestamp per run (see
//    indexObject() above) — this becomes the "last synced" watermark.
// 2. On each sync, query only what changed since that watermark using SystemModstamp
//    (more reliable than LastModifiedDate — updates on every field change, including
//    automation-driven ones):
//      SELECT ... FROM Opportunity WHERE SystemModstamp > :lastSyncedAt
//    Still uses the same (CreatedDate, Id) keyset pagination above if the changed-set is large.
// 3. Upsert (by Salesforce Id, same as full index) naturally overwrites changed records —
//    no explicit delete needed for updates.
// 4. Deletions are NOT caught by a SystemModstamp query (Salesforce doesn't return deleted
//    records). Reconcile separately using the REST `getDeleted()` endpoint
//    (/sobjects/{object}/deleted?start=...&end=...) on a slower cadence (e.g. daily), then
//    delete those specific vector IDs from Pinecone (index.namespace(...).deleteMany([ids])).
// 5. Trigger cadence (cron schedule, webhook, etc.) is intentionally not decided yet — the
//    sync logic above is independent of how/when it's invoked.
