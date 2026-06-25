const CHUNK_SIZE = 1000   // characters
const CHUNK_OVERLAP = 200 // overlap between chunks

export function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0

  const cleaned = text.replace(/\s+/g, ' ').trim()

  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length)
    const chunk = cleaned.slice(start, end).trim()

    if (chunk.length > 50) {
      chunks.push(chunk)
    }

    if (end >= cleaned.length) break
    start = end - CHUNK_OVERLAP
  }

  return chunks
}
