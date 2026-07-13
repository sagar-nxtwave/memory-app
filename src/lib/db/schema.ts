import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  jsonb,
  boolean,
  pgEnum,
  index,
  customType,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// pgvector type (1024 dims = Mistral mistral-embed)
const vector = customType<{ data: number[]; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`
  },
})

// Enums
export const documentStatusEnum = pgEnum('document_status', [
  'pending',
  'processing',
  'ready',
  'failed',
])

export const documentTypeEnum = pgEnum('document_type', [
  'pdf',
  'docx',
  'xlsx',
  'csv',
  'text',
  'pptx',
  'image',
  'zip',
  'email',
  'cad',
])

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant'])

export const spaceMemberRoleEnum = pgEnum('space_member_role', [
  'owner',
  'member',
])

export const spaceStatusEnum = pgEnum('space_status', [
  'new',
  'on_track',
  'at_risk',
  'on_hold',
  'completed',
])

// Users
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Spaces
export const spaces = pgTable('spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  status: spaceStatusEnum('status').notNull().default('new'),
  imageKey: text('image_key'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Space members (owner + invited users)
export const spaceMembers = pgTable('space_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: spaceMemberRoleEnum('role').notNull().default('member'),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
})

// Documents
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fileType: documentTypeEnum('file_type').notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull(),
  status: documentStatusEnum('status').notNull().default('pending'),
  failureReason: text('failure_reason'),
  summary: text('summary'),
  keyNumbers: jsonb('key_numbers').$type<string[]>(),
  risks: jsonb('risks').$type<string[]>(),
  decisions: jsonb('decisions').$type<string[]>(),
  importantDates: jsonb('important_dates').$type<string[]>(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => users.id),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// chunk_type: 'prose' = normal text, 'table' = structured rows from xlsx/csv,
// 'financial' = number-dense prose, 'image' = one figure/diagram (embedding = vision caption + OCR text)
export const chunkTypeEnum = pgEnum('chunk_type', ['prose', 'table', 'financial', 'image'])

// Document chunks (RAG)
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    chunkType: chunkTypeEnum('chunk_type').notNull().default('prose'),
    containsNumbers: boolean('contains_numbers').notNull().default(false),
    // Served URL of the figure this chunk represents — set only when chunkType = 'image'
    imageUrl: text('image_url'),
    // Short human-readable label for the figure (e.g. "FIG. 1 — System Architecture") — set only when chunkType = 'image'
    imageTitle: text('image_title'),
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  // HNSW index required for pgvector — BTree cannot handle 1024-dim vectors (4096 bytes > 2704 byte limit)
  (table) => [index('embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))]
)

// ── Structured tabular data ──────────────────────────────────────────────
// RAG (document_chunks) can only surface the top-K most similar rows, so it can never
// answer "how many students?", "list all IDs", or "average score" over a full column.
// These two tables store spreadsheet/CSV (and any future tabular) data as queryable rows
// so those enumeration/aggregation questions are answered by SQL, not vector retrieval.

export interface ColumnStat {
  name: string
  type: 'number' | 'text' | 'date'
  numericCount: number   // how many rows had a parseable number in this column
  distinctCount: number
  min: number | null
  max: number | null
  avg: number | null
}

// One row per sheet (CSV = one sheet, multi-sheet Excel = one row per sheet).
export const documentTables = pgTable(
  'document_tables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    sheetName: text('sheet_name').notNull(),
    headers: jsonb('headers').$type<string[]>().notNull(),
    rowCount: integer('row_count').notNull().default(0),
    columnStats: jsonb('column_stats').$type<ColumnStat[]>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('document_tables_document_idx').on(table.documentId),
    index('document_tables_space_idx').on(table.spaceId),
  ]
)

// Every data row of a sheet, stored as a JSONB object keyed by header name.
export const documentRows = pgTable(
  'document_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => documentTables.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    data: jsonb('data').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('document_rows_table_idx').on(table.tableId),
    index('document_rows_space_idx').on(table.spaceId),
  ]
)

// Chat messages
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  // Assistant-only: citations/images resolved at answer time — persisted so they
  // survive a page refresh instead of only existing on the live SSE response.
  // spaceName is set when the answer pulled in another space (cross-space comparison
  // asked from within this space's chat — see crossSpaceIntent.ts).
  citations: jsonb('citations').$type<{ documentId?: string; documentName: string; spaceName?: string; url?: string; sourceType?: 'internal' | 'web'; citationId?: string }[]>(),
  documentImages: jsonb('document_images').$type<{ url: string; alt: string; documentName: string }[]>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Message feedback (thumbs up/down on assistant messages)
export const messageFeedback = pgTable('message_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vote: text('vote').notNull(), // 'up' | 'down'
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// Global chat messages (cross-space — no spaceId)
export const globalMessages = pgTable('global_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  citations: jsonb('citations').$type<{ documentId?: string; documentName: string; spaceName?: string; url?: string; sourceType?: 'internal' | 'web'; citationId?: string }[]>(),
  documentImages: jsonb('document_images').$type<{ url: string; alt: string; documentName: string; spaceName?: string }[]>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ── Web search ────────────────────────────────────────────────────────────
// Cached provider results — web search is a paid per-query API, so identical queries
// (same normalized query + provider + depth + maxResults hash) reuse a cached result
// until it expires. Survives serverless cold starts (unlike an in-memory Map).
export const webSearchCache = pgTable(
  'web_search_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryHash: text('query_hash').notNull().unique(),
    query: text('query').notNull(),
    provider: text('provider').notNull(),
    results: jsonb('results').$type<unknown>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => [index('web_search_cache_hash_idx').on(table.queryHash)]
)

// One row per web search request (observability: query volume, latency, failures, cache hit rate).
export const webSearchLogs = pgTable(
  'web_search_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    query: text('query').notNull(),
    provider: text('provider').notNull(),
    latencyMs: integer('latency_ms'),
    resultsReturned: integer('results_returned'),
    cacheHit: boolean('cache_hit').notNull().default(false),
    error: text('error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('web_search_logs_created_idx').on(table.createdAt)]
)

// Space visits (powers "Catch Me Up")
export const spaceVisits = pgTable('space_visits', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  visitedAt: timestamp('visited_at').notNull().defaultNow(),
})

// ── Salesforce RAG ────────────────────────────────────────────────────────
// Vector storage moved to Pinecone (free serverless tier, 2GB) — see
// src/salesforce/pinecone-client.ts, rag-indexer.ts, rag-searcher.ts. Neon/pgvector
// (the salesforce_chunks table that used to live here) hit the 512MB database size
// ceiling well before all ~141K target Salesforce records could be indexed (the HNSW
// vector index alone cost ~3x the raw row size). salesforceIndexRuns below still lives
// in Neon since it's tiny (just run metadata) and needs relational tracking.

// Tracks indexing runs — lets the indexer resume/incrementally update instead
// of re-pulling all objects every time, and gives visibility into freshness.
export const salesforceIndexRuns = pgTable('salesforce_index_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  objectName: text('object_name').notNull(),
  recordsIndexed: integer('records_indexed').notNull().default(0),
  status: text('status').notNull().default('running'), // running | completed | failed
  error: text('error'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
})

// Business Glossary — editable business-term-to-schema mappings (e.g. "Customer" ->
// Account/Contact, "Unit" -> Opportunity.Name pattern) that get injected into the MCP/
// tool-matcher prompts so the LLM understands the client's own terminology. Distinct from
// the auto-extracted per-field definitions in data/llm-rules.json (those are read-only,
// client-provided; this table is what the client/team can add to via Settings). Stored in
// the DB (not a JSON file) since Vercel's serverless filesystem doesn't persist writes.
export const glossaryTerms = pgTable('glossary_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  term: text('term').notNull(), // business term, e.g. "Customer", "Unit"
  mapsTo: text('maps_to').notNull(), // schema mapping, e.g. "Account or Contact"
  explanation: text('explanation').notNull(), // when/how to apply this mapping
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Skill Files — free-form instruction documents (markdown/text) that get injected into
// the MCP system prompt. Unlike glossary terms (structured term→field mappings), skill
// files contain detailed business rules, query patterns, and domain knowledge that help
// the LLM answer questions correctly. Users can add/edit these via Settings UI.
// triggerWords: comma-separated keywords that trigger loading this skill (e.g. "owner,buyer,customer")
export const skillFiles = pgTable('skill_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(), // e.g. "Sales Rules", "Property Lookup Guide"
  category: text('category').notNull().default('general'), // general, sales, property, ownership, etc.
  triggerWords: text('trigger_words').notNull().default(''), // comma-separated keywords for conditional loading
  content: text('content').notNull(), // free-form markdown/text with instructions
  active: boolean('active').notNull().default(true), // toggle without deleting
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  spaces: many(spaces),
  spaceMembers: many(spaceMembers),
  documents: many(documents),
  messages: many(messages),
  globalMessages: many(globalMessages),
  spaceVisits: many(spaceVisits),
}))

export const spacesRelations = relations(spaces, ({ one, many }) => ({
  createdBy: one(users, { fields: [spaces.createdBy], references: [users.id] }),
  members: many(spaceMembers),
  documents: many(documents),
  messages: many(messages),
  visits: many(spaceVisits),
}))

export const documentsRelations = relations(documents, ({ one, many }) => ({
  space: one(spaces, { fields: [documents.spaceId], references: [spaces.id] }),
  uploadedBy: one(users, { fields: [documents.uploadedBy], references: [users.id] }),
  chunks: many(documentChunks),
  tables: many(documentTables),
}))

export const documentTablesRelations = relations(documentTables, ({ one, many }) => ({
  document: one(documents, { fields: [documentTables.documentId], references: [documents.id] }),
  space: one(spaces, { fields: [documentTables.spaceId], references: [spaces.id] }),
  rows: many(documentRows),
}))

export const documentRowsRelations = relations(documentRows, ({ one }) => ({
  table: one(documentTables, { fields: [documentRows.tableId], references: [documentTables.id] }),
}))

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, {
    fields: [documentChunks.documentId],
    references: [documents.id],
  }),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  space: one(spaces, { fields: [messages.spaceId], references: [spaces.id] }),
  user: one(users, { fields: [messages.userId], references: [users.id] }),
}))
