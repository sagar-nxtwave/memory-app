import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  jsonb,
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
])

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant'])

export const spaceMemberRoleEnum = pgEnum('space_member_role', [
  'owner',
  'member',
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
  summary: text('summary'),
  keyNumbers: jsonb('key_numbers').$type<string[]>(),
  risks: jsonb('risks').$type<string[]>(),
  decisions: jsonb('decisions').$type<string[]>(),
  importantDates: jsonb('important_dates').$type<string[]>(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

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
    embedding: vector('embedding', { dimensions: 1024 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  // HNSW index required for pgvector — BTree cannot handle 1024-dim vectors (4096 bytes > 2704 byte limit)
  (table) => [index('embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))]
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

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
