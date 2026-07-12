// Salesforce RAG indexer — pulls records from key objects, flattens each into searchable
// text, embeds them, and stores in `salesforce_chunks` (pgvector). This is the fallback
// data source for questions the 100+ pre-built tools can't answer (e.g. ad-hoc price-range
// breakdowns, cross-field lookups). Tools remain the fast/reliable path for common queries;
// this exists purely so "the data is there but no tool matches" never means "no answer".
import { soql } from './client'
import { generateEmbeddings } from '@/lib/ai/provider'
import { db } from '@/lib/db'
import { salesforceChunks, salesforceIndexRuns } from '@/lib/db/schema'
import { eq, sql as drizzleSql } from 'drizzle-orm'

export interface IndexableObject {
  objectName: string
  soqlFields: string
  where?: string
  orderBy: string
  limit: number
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
    orderBy: 'CreatedDate DESC',
    limit: 3000,
    toText: (r) =>
      `Opportunity: ${r.Name} | Stage: ${r.StageName} | Amount: AED ${r.Amount ?? 'N/A'} | Close Date: ${r.CloseDate ?? 'N/A'} | Building: ${r.Building_Name__c ?? 'N/A'} | Community: ${r.Building_Community__c ?? 'N/A'} | Bedroom: ${r.Sales_Room__c ?? 'N/A'} | Customer: ${(r.Account as { Name?: string })?.Name ?? 'N/A'} | Sales Person: ${(r.cm_Sales_Person__r as { Name?: string })?.Name ?? 'N/A'} | Won: ${r.IsWon} | Closed: ${r.IsClosed}`,
  },
  {
    objectName: 'Property_Inventory__c',
    soqlFields: 'Id, Name, Building_Community__c, Property_Status__c, Type__c, Selling_Price__c, Property_Usage__c, CreatedDate',
    orderBy: 'CreatedDate DESC',
    limit: 3000,
    toText: (r) =>
      `Property: ${r.Name} | Community: ${r.Building_Community__c ?? 'N/A'} | Status: ${r.Property_Status__c ?? 'N/A'} | Type: ${r.Type__c ?? 'N/A'} | Price: AED ${r.Selling_Price__c ?? 'N/A'} | Usage: ${r.Property_Usage__c ?? 'N/A'}`,
  },
  {
    objectName: 'Account',
    soqlFields: 'Id, Name, Type, CreatedDate',
    orderBy: 'CreatedDate DESC',
    limit: 2000,
    toText: (r) => `Account: ${r.Name} | Type: ${r.Type ?? 'N/A'}`,
  },
  {
    objectName: 'Case',
    soqlFields: 'Id, CaseNumber, Subject, Status, Origin, Priority, CreatedDate',
    orderBy: 'CreatedDate DESC',
    limit: 2000,
    toText: (r) =>
      `Case ${r.CaseNumber}: ${r.Subject ?? 'N/A'} | Status: ${r.Status ?? 'N/A'} | Origin: ${r.Origin ?? 'N/A'} | Priority: ${r.Priority ?? 'N/A'}`,
  },
]

const EMBED_BATCH_SIZE = 64
// Guardrail caps LIMIT at 500 per query — page through with OFFSET to reach the target
// record count. SOQL OFFSET itself maxes out at 2000, so total per object tops out there.
const SOQL_PAGE_SIZE = 500
const MAX_SOQL_OFFSET = 2000

/** Pulls up to `targetLimit` records (capped by SOQL's 2000 OFFSET ceiling) via paginated queries. */
async function fetchAllRecords(spec: IndexableObject): Promise<Record<string, unknown>[]> {
  const whereClause = spec.where ? ` WHERE ${spec.where}` : ''
  const allRecords: Record<string, unknown>[] = []
  const effectiveLimit = Math.min(spec.limit, MAX_SOQL_OFFSET + SOQL_PAGE_SIZE)

  for (let offset = 0; offset < effectiveLimit; offset += SOQL_PAGE_SIZE) {
    const pageSize = Math.min(SOQL_PAGE_SIZE, effectiveLimit - offset)
    const offsetClause = offset > 0 ? ` OFFSET ${offset}` : ''
    const query = `SELECT ${spec.soqlFields} FROM ${spec.objectName}${whereClause} ORDER BY ${spec.orderBy} LIMIT ${pageSize}${offsetClause}`
    const result = await soql(query)
    allRecords.push(...result.records)
    if (result.records.length < pageSize) break // fewer records than requested — reached the end
    if (offset + SOQL_PAGE_SIZE > MAX_SOQL_OFFSET) break // hit SOQL's OFFSET ceiling
  }

  return allRecords
}

export interface IndexResult {
  objectName: string
  recordsIndexed: number
  status: 'completed' | 'failed'
  error?: string
}

/** Indexes a single object's records into salesforce_chunks. Replaces prior chunks for that object. */
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

    // Flatten + embed in batches, then delete old chunks for this object and insert new ones.
    // Delete-then-insert (not upsert) keeps this simple since record sets change significantly
    // between indexing runs (new sales, status changes).
    await db.delete(salesforceChunks).where(eq(salesforceChunks.objectName, spec.objectName))

    let totalIndexed = 0
    for (let i = 0; i < records.length; i += EMBED_BATCH_SIZE) {
      const batch = records.slice(i, i + EMBED_BATCH_SIZE)
      const texts = batch.map((r) => spec.toText(r))
      const embeddings = await generateEmbeddings(texts)

      const rows = batch.map((r, idx) => ({
        objectName: spec.objectName,
        recordId: String(r.Id ?? ''),
        content: texts[idx],
        metadata: r as Record<string, unknown>,
        embedding: embeddings[idx],
      }))

      await db.insert(salesforceChunks).values(rows)
      totalIndexed += rows.length
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

/** Returns freshness info — how many chunks exist and when they were last indexed, per object. */
export async function getIndexStatus(): Promise<{ objectName: string; count: number; lastIndexedAt: Date | null }[]> {
  const rows = await db
    .select({
      objectName: salesforceChunks.objectName,
      count: drizzleSql<number>`count(*)::int`,
      lastIndexedAt: drizzleSql<Date>`max(${salesforceChunks.indexedAt})`,
    })
    .from(salesforceChunks)
    .groupBy(salesforceChunks.objectName)

  return rows.map((r) => ({ objectName: r.objectName, count: r.count, lastIndexedAt: r.lastIndexedAt }))
}
