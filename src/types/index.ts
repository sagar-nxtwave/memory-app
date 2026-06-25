export type UserRole = 'owner' | 'member'
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed'
export type MessageRole = 'user' | 'assistant'
export type DocumentType = 'pdf' | 'docx' | 'xlsx' | 'csv'

export interface Space {
  id: string
  name: string
  description: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface Document {
  id: string
  spaceId: string
  name: string
  fileType: DocumentType
  fileSize: number
  storageKey: string
  status: DocumentStatus
  summary: string | null
  keyNumbers: string[] | null
  risks: string[] | null
  decisions: string[] | null
  uploadedBy: string
  createdAt: Date
  updatedAt: Date
}

export interface Message {
  id: string
  spaceId: string
  userId: string
  role: MessageRole
  content: string
  createdAt: Date
}

export interface TimelineEvent {
  id: string
  type: 'document_uploaded' | 'document_processed' | 'decision_recorded'
  title: string
  description: string | null
  spaceId: string
  documentId: string | null
  createdAt: Date
}

export interface BriefingData {
  summary: string
  status: string
  keyNumbers: string[]
  risks: string[]
  recentDecisions: string[]
  recentDocuments: { name: string; uploadedAt: Date }[]
}

export interface CatchUpData {
  since: Date
  newDocuments: { name: string; summary: string; uploadedAt: Date }[]
  newDecisions: string[]
  changesCount: number
  highlights: string[]
}
