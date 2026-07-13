// Auto-generated metadata graph — discovers object relationships from
// Salesforce describe() metadata. Used for relationship traversal
// (navigating between objects).

import { describeObject, type FieldInfo } from './client'

export interface RelationshipField {
  fieldName: string
  targetObjects: string[]
  type: string // 'reference' (lookup) or 'master-detail'
  label: string
}

export interface GraphPath {
  steps: { from: string; viaField: string; to: string }[]
}

// Module-level caches — rebuilt when MCP session expires.
let cachedGraph: Map<string, RelationshipField[]> | null = null

/**
 * Build a metadata graph for the given objects by reading their describe metadata.
 * Returns a map from object name → relationship fields.
 */
export async function buildMetadataGraph(objects: string[]): Promise<Map<string, RelationshipField[]>> {
  if (cachedGraph) return cachedGraph

  const graph = new Map<string, RelationshipField[]>()

  for (const obj of objects) {
    try {
      const fields: FieldInfo[] = await describeObject(obj)

      const relFields: RelationshipField[] = fields
        .filter((f) => f.referenceTo.length > 0)
        .map((f) => ({
          fieldName: f.name,
          targetObjects: f.referenceTo,
          type: f.type === 'reference' ? 'lookup' : f.type,
          label: f.label,
        }))

      graph.set(obj, relFields)
    } catch (err) {
      console.warn(`[metadata-graph] Failed to describe ${obj}:`, err)
      graph.set(obj, [])
    }
  }

  cachedGraph = graph
  return graph
}

/** Clear the cached graph (e.g. on MCP session expiry). */
export function clearMetadataGraph(): void {
  cachedGraph = null
}

/**
 * Find all paths from `fromObj` to `toObj` using BFS, up to maxDepth hops.
 * Each path is a sequence of { from, viaField, to } steps.
 */
export function findPaths(
  graph: Map<string, RelationshipField[]>,
  fromObj: string,
  toObj: string,
  maxDepth: number = 3,
): GraphPath[] {
  if (fromObj === toObj) return [{ steps: [] }]

  const paths: GraphPath[] = []
  const queue: { current: string; steps: GraphPath['steps']; visited: Set<string> }[] = [
    { current: fromObj, steps: [], visited: new Set([fromObj]) },
  ]

  while (queue.length > 0) {
    const { current, steps, visited } = queue.shift()!
    if (steps.length >= maxDepth) continue

    const relFields = graph.get(current) ?? []
    for (const rel of relFields) {
      for (const target of rel.targetObjects) {
        if (target === toObj) {
          paths.push({ steps: [...steps, { from: current, viaField: rel.fieldName, to: target }] })
        } else if (!visited.has(target) && graph.has(target)) {
          const newVisited = new Set(visited)
          newVisited.add(target)
          queue.push({
            current: target,
            steps: [...steps, { from: current, viaField: rel.fieldName, to: target }],
            visited: newVisited,
          })
        }
      }
    }
  }

  return paths
}

/**
 * Format traversal paths as prompt text for the MCP system prompt.
 * Shows the recommended order and JOIN syntax.
 */
export function formatPathsForPrompt(
  graph: Map<string, RelationshipField[]>,
  fromObj: string,
  toObj: string,
): string | null {
  const paths = findPaths(graph, fromObj, toObj)
  if (paths.length === 0) return null

  const lines: string[] = []
  paths.forEach((path, idx) => {
    const label = idx === 0 ? '(RECOMMENDED — try first)' : `(alternative ${idx})`
    const joinParts = path.steps.map((s) => `${s.from}.${s.viaField} → ${s.to}`)

    lines.push(`  ${idx + 1}. ${label}: ${fromObj} → ${toObj}`)
    lines.push(`     Via: ${joinParts.join(' → ')}`)
    lines.push('')
  })

  return lines.join('\n')
}

/**
 * Get relationship fields for a specific object from the graph.
 * Returns empty array if object not in graph.
 */
export function getRelationships(
  graph: Map<string, RelationshipField[]>,
  objectName: string,
): RelationshipField[] {
  return graph.get(objectName) ?? []
}
