import { z } from 'zod'
import { v5 as uuidv5 } from 'uuid'
import { join } from 'path'
import { readFile } from 'fs/promises'
import postgres from 'postgres'

export type PostgresClient = ReturnType<typeof postgres>

const BRANCH = 'main'
const SVGS_BASE_URL = `https://raw.githubusercontent.com/fmkra/pplka-explanations/refs/heads/${BRANCH}/explanations/`
const EXPLANATIONS_DIR = join(process.cwd(), 'explanations')

const knowledgeBaseNode: z.ZodTypeAny = z.lazy(() =>
  z.union([knowledgeBaseNodeFile, knowledgeBaseNodeFolder]),
)

const knowledgeBaseNodeFile = z.object({
  name: z.string(),
  slug: z.string(),
  files: z.array(z.string()),
})

const knowledgeBaseNodeFolder = z.object({
  name: z.string(),
  children: z.array(knowledgeBaseNode),
})

type KnowledgeBaseNode =
  | z.infer<typeof knowledgeBaseNodeFile>
  | z.infer<typeof knowledgeBaseNodeFolder>

type KnowledgeBaseNodeRowNoId = {
  name: string
  slug: string | null
  type: 'file' | 'folder'
  parentId: string | null
  order: number
}

type KnowledgeBaseNodeRow = KnowledgeBaseNodeRowNoId & {
  id: string
}

const questionDataSchema = z.object({
  explanations: z.array(z.string()),
  extra: z.array(z.string()),
})

const metaSchema = z.object({
  knowledge_base: z.array(knowledgeBaseNode),
  questions: z.record(z.string(), questionDataSchema).default({}),
})

type QuestionData = z.infer<typeof questionDataSchema>

type Meta = {
  knowledge_base: KnowledgeBaseNode[]
  questions: Record<string, QuestionData>
}

type ExplanationRow = {
  id: string
  explanation: string
  type: 'text' | 'image'
  file: string
}

type KbNodeToExplanationRow = {
  knowledgeBaseNodeId: string
  explanationId: string
  order: number
}

/** Same rule as insert-explanations / sync: one stable UUID per explanation file path. */
export function explanationIdFromFile(filePath: string): string {
  return uuidv5(filePath, uuidv5.URL)
}

/** Stable primary key for a `question_to_explanation` row (replaces uuid v4 per link). */
export function questionToExplanationLinkId(
  externalId: string,
  order: number,
  file: string,
): string {
  return uuidv5(
    JSON.stringify(['question-to-explanation', externalId, order, file]),
    uuidv5.URL,
  )
}

export type QuestionToExplanationRow = {
  id: string
  questionId: string
  questionExternalId: string
  explanationId: string
  order: number
  isExtraResource: boolean
}

/** Loads `id` for each `externalId` present in `nauka-ppla_question` (single round-trip). */
export async function fetchQuestionIdsByExternalIds(
  sql: PostgresClient,
  externalIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (externalIds.length === 0) return map
  const rows = await sql`
    SELECT id, "externalId"
    FROM "nauka-ppla_question"
    WHERE "externalId" IN ${sql(externalIds)}
  `
  for (const row of rows as unknown as {
    id: string
    externalId: string
  }[]) {
    map.set(row.externalId, row.id)
  }
  return map
}

function knowledgeBaseNodeMakeId(
  node: KnowledgeBaseNodeRowNoId,
): KnowledgeBaseNodeRow {
  const allFields = [node.name, node.slug, node.type, node.parentId, node.order]
  return {
    ...node,
    id: uuidv5(JSON.stringify(allFields), uuidv5.URL),
  }
}

export function parseRows(
  parentId: string | null,
  order: number,
  node: KnowledgeBaseNode,
): [KnowledgeBaseNodeRow[], Set<string>, KbNodeToExplanationRow[]] {
  if ('files' in node) {
    const row = knowledgeBaseNodeMakeId({
      name: node.name,
      slug: node.slug,
      type: 'file',
      parentId,
      order,
    })
    return [
      [row],
      new Set(node.files),
      node.files.map((file, index) => ({
        knowledgeBaseNodeId: row.id,
        explanationId: explanationIdFromFile(file),
        order: index,
      })),
    ]
  } else {
    const row = knowledgeBaseNodeMakeId({
      name: node.name,
      slug: null,
      type: 'folder',
      parentId,
      order,
    })
    const out = parseRowsChildren(row.id, node.children)
    out[0].unshift(row)
    return out
  }
}

function parseRowsChildren(
  parentId: string | null,
  children: KnowledgeBaseNode[],
): [KnowledgeBaseNodeRow[], Set<string>, KbNodeToExplanationRow[]] {
  const allFiles = new Set<string>()
  const allKbNodeToExplanationRows: KbNodeToExplanationRow[] = []
  return [
    children.flatMap((child, index) => {
      const [rows, files, kbNodeToExplanationRows] = parseRows(
        parentId,
        index,
        child,
      )
      allKbNodeToExplanationRows.push(...kbNodeToExplanationRows)
      files.forEach((file) => allFiles.add(file))
      return rows
    }),
    allFiles,
    allKbNodeToExplanationRows,
  ]
}

function collectQuestionReferencedFiles(
  questions: Record<string, QuestionData>,
): Set<string> {
  const paths = new Set<string>()
  for (const q of Object.values(questions)) {
    for (const file of q.explanations) paths.add(file)
    for (const file of q.extra) paths.add(file)
  }
  return paths
}

/**
 * Mirrors insert-explanations: explanations first (isExtraResource: false),
 * then extra (true). Skips missing files like the INSERT script (`continue`).
 */
function buildQuestionToExplanationRows(
  questions: Record<string, QuestionData>,
  loadedFilePaths: Set<string>,
  questionIdByExternalId: Map<string, string>,
): QuestionToExplanationRow[] {
  const rows: QuestionToExplanationRow[] = []
  for (const externalId of Object.keys(questions).sort()) {
    const data = questions[externalId]
    const questionId = questionIdByExternalId.get(externalId)
    if (!questionId) {
      console.warn(`Warning: Question not found: ${externalId}`)
      continue
    }
    const allFiles: [string, boolean][] = [
      ...data.explanations.map((file) => [file, false] as [string, boolean]),
      ...data.extra.map((file) => [file, true] as [string, boolean]),
    ]
    for (let order = 0; order < allFiles.length; order++) {
      const [file, isExtraResource] = allFiles[order]
      if (!loadedFilePaths.has(file)) {
        console.warn(
          `Warning: File not found for question ${externalId}, skipping link: ${file}`,
        )
        continue
      }
      rows.push({
        id: questionToExplanationLinkId(externalId, order, file),
        questionId,
        questionExternalId: externalId,
        explanationId: explanationIdFromFile(file),
        order,
        isExtraResource,
      })
    }
  }
  return rows
}

async function loadExplanationFile(
  file: string,
): Promise<ExplanationRow | null> {
  try {
    let explanation: string
    let type: 'text' | 'image'
    if (file.endsWith('.svg')) {
      explanation = `${SVGS_BASE_URL}${encodeURIComponent(file)}`
      type = 'image'
    } else if (file.endsWith('.md')) {
      explanation = await readFile(join(EXPLANATIONS_DIR, file), 'utf-8')
      type = 'text'
    } else {
      throw new Error(`Unknown file type: ${file}`)
    }
    return {
      id: explanationIdFromFile(file),
      explanation,
      type,
      file,
    }
  } catch {
    console.warn(`Warning: File not found or unreadable: ${file}`)
    return null
  }
}

/**
 * @param sql Required when `meta.questions` is non-empty — used to resolve real `questionId`
 *        from `"nauka-ppla_question"."externalId"` (same as `insert-explanations.ts`).
 */
export async function generateRows(meta: Meta, sql?: PostgresClient) {
  const [knowledgeBaseRows, knowledgeBaseFiles, kbNodeToExplanationRows] =
    parseRowsChildren(null, meta.knowledge_base)

  const referencedByQuestions = collectQuestionReferencedFiles(meta.questions)
  const unionFiles = new Set<string>([
    ...knowledgeBaseFiles,
    ...referencedByQuestions,
  ])
  const sortedFiles = [...unionFiles].sort((a, b) => a.localeCompare(b))

  const loadedRows = (
    await Promise.all(sortedFiles.map((file) => loadExplanationFile(file)))
  ).filter((row): row is ExplanationRow => row !== null)

  const loadedPaths = new Set(loadedRows.map((r) => r.file))
  const loadedExplanationIds = new Set(loadedRows.map((r) => r.id))

  const kbNodeToExplanationRowsFiltered = kbNodeToExplanationRows.filter(
    (row) => loadedExplanationIds.has(row.explanationId),
  )

  const questionExternalIds = Object.keys(meta.questions)
  let questionIdByExternalId = new Map<string, string>()
  if (questionExternalIds.length > 0) {
    if (!sql) {
      throw new Error(
        'generateRows: pass a postgres client as the second argument when meta.json has `questions` (needed to load question ids from the database)',
      )
    }
    questionIdByExternalId = await fetchQuestionIdsByExternalIds(
      sql,
      questionExternalIds,
    )
  }

  const questionToExplanationRows = buildQuestionToExplanationRows(
    meta.questions,
    loadedPaths,
    questionIdByExternalId,
  )

  const managedExplanationIds = [
    ...new Set([
      ...loadedExplanationIds,
      ...[...unionFiles].map((file) => explanationIdFromFile(file)),
    ]),
  ]

  return {
    knowledgeBaseRows,
    explanationRows: loadedRows,
    kbNodeToExplanationRows: kbNodeToExplanationRowsFiltered,
    questionToExplanationRows,
    managedExplanationIds,
  }
}

export type GeneratedRows = Awaited<ReturnType<typeof generateRows>>

export type SyncStats = {
  explanationsDeleted: number
  explanationsInserted: number
  explanationsUpdated: number
  knowledgeBaseNodesDeleted: number
  knowledgeBaseNodesInserted: number
  knowledgeBaseNodesUpdated: number
  kbNodeToExplanationDeleted: number
  kbNodeToExplanationInserted: number
  questionToExplanationDeleted: number
  questionToExplanationInserted: number
  questionToExplanationUpdated: number
  contentFeedbackDeleted: number
}

export type KbNodeRerenderReason =
  | 'explanation'
  | 'kb_links'
  | 'question_count'
  | 'node_fields'
  /** KB tree changed; every page's nav must be rebuilt (includes all surviving file nodes). */
  | 'navigation'

/** File-type KB node that should be rebuilt on the static site (superset of actual changes). */
export type KbNodeRerenderTarget = {
  id: string
  slug: string | null
  name: string
  reasons: KbNodeRerenderReason[]
  /** Present when the node was removed from the KB tree (regenerate to drop the page). */
  deleted?: boolean
}

type QteLink = Pick<
  QuestionToExplanationRow,
  'id' | 'questionId' | 'explanationId'
>

function kbLinkKey(row: {
  knowledgeBaseNodeId: string
  explanationId: string
  order: number
}): string {
  return JSON.stringify([row.knowledgeBaseNodeId, row.explanationId, row.order])
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

/**
 * Compare `fetchCurrentRows(tx)` to `desiredRows` using `keyOf`.
 * Removed keys → `toDelete`, new keys → `toInsert`, same key but changed → `toUpdate`
 * (so rows still referenced by FKs are updated in place, not deleted).
 */
export async function diffSetByKey<T>(
  tx: PostgresClient,
  config: {
    fetchCurrentRows: (tx: PostgresClient) => Promise<T[]>
    desiredRows: T[]
    keyOf: (row: T) => string
    /** Same key in DB and desired but payload differs — use `updateRows`, not delete+insert. */
    replaceIfChanged?: (current: T, desired: T) => boolean
  },
): Promise<{ toDelete: T[]; toInsert: T[]; toUpdate: T[] }> {
  const current = await config.fetchCurrentRows(tx)
  const byKeyCurrent = new Map(current.map((r) => [config.keyOf(r), r]))
  const byKeyDesired = new Map(
    config.desiredRows.map((r) => [config.keyOf(r), r]),
  )

  const toDelete: T[] = []
  const toInsert: T[] = []
  const toUpdate: T[] = []
  for (const [k, cur] of byKeyCurrent) {
    const want = byKeyDesired.get(k)
    if (!want) {
      toDelete.push(cur)
    } else if (config.replaceIfChanged?.(cur, want)) {
      toUpdate.push(want)
    }
  }
  for (const [k, want] of byKeyDesired) {
    if (!byKeyCurrent.has(k)) toInsert.push(want)
  }
  return { toDelete, toInsert, toUpdate }
}

export type SetSyncTable<T> = {
  name: string
  fetchCurrentRows: (tx: PostgresClient) => Promise<T[]>
  desiredRows: T[]
  keyOf: (row: T) => string
  replaceIfChanged?: (current: T, desired: T) => boolean
  deleteRows: (tx: PostgresClient, rows: T[]) => Promise<void>
  insertRows: (tx: PostgresClient, rows: T[]) => Promise<void>
  /** Required when `replaceIfChanged` is set — same-key changes are updated in place. */
  updateRows?: (tx: PostgresClient, rows: T[]) => Promise<void>
}

export type PreparedSetSync = {
  name: string
  toDelete: unknown[]
  toInsert: unknown[]
  toUpdate: unknown[]
  runDeletes: (tx: PostgresClient) => Promise<void>
  runUpdates: (tx: PostgresClient) => Promise<void>
  runInserts: (tx: PostgresClient) => Promise<void>
}

export async function prepareSetSync<T>(
  tx: PostgresClient,
  table: SetSyncTable<T>,
): Promise<PreparedSetSync> {
  const { toDelete, toInsert, toUpdate } = await diffSetByKey(tx, {
    fetchCurrentRows: table.fetchCurrentRows,
    desiredRows: table.desiredRows,
    keyOf: table.keyOf,
    replaceIfChanged: table.replaceIfChanged,
  })
  if (toUpdate.length > 0 && !table.updateRows) {
    throw new Error(
      `prepareSetSync(${table.name}): ${toUpdate.length} row(s) need in-place update but updateRows is missing`,
    )
  }
  return {
    name: table.name,
    toDelete,
    toInsert,
    toUpdate,
    runDeletes: async (tx2) => {
      if (toDelete.length > 0) await table.deleteRows(tx2, toDelete)
    },
    runUpdates: async (tx2) => {
      if (toUpdate.length > 0) await table.updateRows!(tx2, toUpdate)
    },
    runInserts: async (tx2) => {
      if (toInsert.length > 0) await table.insertRows(tx2, toInsert)
    },
  }
}

/**
 * Deletes (dependents first), updates in place (same key), then inserts (reverse of delete order).
 */
export async function runDeletesThenInserts(
  tx: PostgresClient,
  deleteStepOrder: PreparedSetSync[],
  insertStepOrder: PreparedSetSync[],
): Promise<
  Record<string, { deleted: number; inserted: number; updated: number }>
> {
  const out: Record<
    string,
    { deleted: number; inserted: number; updated: number }
  > = {}
  for (const p of deleteStepOrder) {
    await p.runDeletes(tx)
    out[p.name] = { deleted: p.toDelete.length, inserted: 0, updated: 0 }
  }
  const updateStepOrder = [...insertStepOrder]
  for (const p of updateStepOrder) {
    await p.runUpdates(tx)
    const prev = out[p.name] ?? { deleted: 0, inserted: 0, updated: 0 }
    out[p.name] = { ...prev, updated: p.toUpdate.length }
  }
  for (const p of insertStepOrder) {
    await p.runInserts(tx)
    const prev = out[p.name] ?? { deleted: 0, inserted: 0, updated: 0 }
    out[p.name] = { ...prev, inserted: p.toInsert.length }
  }
  return out
}

function applyKbLinkDiff(
  before: KbNodeToExplanationRow[],
  sync: PreparedSetSync,
): KbNodeToExplanationRow[] {
  const deletedKeys = new Set(
    (sync.toDelete as KbNodeToExplanationRow[]).map(kbLinkKey),
  )
  const kept = before.filter((r) => !deletedKeys.has(kbLinkKey(r)))
  return [...kept, ...(sync.toInsert as KbNodeToExplanationRow[])]
}

function applyQteDiff(before: QteLink[], sync: PreparedSetSync): QteLink[] {
  const deletedIds = new Set(
    (sync.toDelete as QuestionToExplanationRow[]).map((r) => r.id),
  )
  const byId = new Map(
    before.filter((r) => !deletedIds.has(r.id)).map((r) => [r.id, r]),
  )
  for (const r of sync.toUpdate as QuestionToExplanationRow[]) {
    byId.set(r.id, r)
  }
  for (const r of sync.toInsert as QuestionToExplanationRow[]) {
    byId.set(r.id, r)
  }
  return [...byId.values()]
}

function uniqueQuestionCountForKbNode(
  nodeId: string,
  kbLinks: KbNodeToExplanationRow[],
  qteLinks: QteLink[],
): number {
  const explanationIds = new Set(
    kbLinks
      .filter((l) => l.knowledgeBaseNodeId === nodeId)
      .map((l) => l.explanationId),
  )
  if (explanationIds.size === 0) return 0
  const questionIds = new Set<string>()
  for (const q of qteLinks) {
    if (explanationIds.has(q.explanationId)) questionIds.add(q.questionId)
  }
  return questionIds.size
}

/** True when any `knowledge_base_node` row was inserted, updated, or deleted. */
export function isKnowledgeBaseTreeChanged(
  kbNodeSync: PreparedSetSync,
): boolean {
  return (
    kbNodeSync.toDelete.length > 0 ||
    kbNodeSync.toInsert.length > 0 ||
    kbNodeSync.toUpdate.length > 0
  )
}

export type ComputeKbNodesToRerenderResult = {
  kbNodesToRerender: KbNodeRerenderTarget[]
  knowledgeBaseTreeChanged: boolean
}

/**
 * KB file nodes to rerender after sync (superset: may include extra nodes, never omits required ones).
 * Uses sync diffs plus post-sync link/question projections.
 */
export function computeKbNodesToRerender(input: {
  knowledgeBaseRows: KnowledgeBaseNodeRow[]
  explanationSync: PreparedSetSync
  kbLinkSync: PreparedSetSync
  qteSync: PreparedSetSync
  kbNodeSync: PreparedSetSync
  kbLinksBefore: KbNodeToExplanationRow[]
  qteBefore: QteLink[]
}): ComputeKbNodesToRerenderResult {
  const {
    knowledgeBaseRows,
    explanationSync,
    kbLinkSync,
    qteSync,
    kbNodeSync,
    kbLinksBefore,
    qteBefore,
  } = input

  const kbLinksAfter = applyKbLinkDiff(kbLinksBefore, kbLinkSync)
  const qteAfter = applyQteDiff(qteBefore, qteSync)

  const fileNodes = knowledgeBaseRows.filter((n) => n.type === 'file')
  const nodeById = new Map(fileNodes.map((n) => [n.id, n]))

  const touchedExplanationIds = new Set<string>()
  for (const r of [
    ...(explanationSync.toDelete as ExplanationRow[]),
    ...(explanationSync.toInsert as ExplanationRow[]),
    ...(explanationSync.toUpdate as ExplanationRow[]),
  ]) {
    touchedExplanationIds.add(r.id)
  }
  for (const r of [
    ...(qteSync.toDelete as QuestionToExplanationRow[]),
    ...(qteSync.toInsert as QuestionToExplanationRow[]),
    ...(qteSync.toUpdate as QuestionToExplanationRow[]),
  ]) {
    touchedExplanationIds.add(r.explanationId)
  }

  const reasonsByNodeId = new Map<string, Set<KbNodeRerenderReason>>()

  const addReason = (nodeId: string, reason: KbNodeRerenderReason) => {
    if (!nodeById.has(nodeId)) return
    let set = reasonsByNodeId.get(nodeId)
    if (!set) {
      set = new Set()
      reasonsByNodeId.set(nodeId, set)
    }
    set.add(reason)
  }

  for (const r of [
    ...(kbLinkSync.toDelete as KbNodeToExplanationRow[]),
    ...(kbLinkSync.toInsert as KbNodeToExplanationRow[]),
  ]) {
    addReason(r.knowledgeBaseNodeId, 'kb_links')
  }

  for (const link of [...kbLinksBefore, ...kbLinksAfter]) {
    if (touchedExplanationIds.has(link.explanationId)) {
      addReason(link.knowledgeBaseNodeId, 'explanation')
    }
  }

  for (const node of fileNodes) {
    const before = uniqueQuestionCountForKbNode(
      node.id,
      kbLinksBefore,
      qteBefore,
    )
    const after = uniqueQuestionCountForKbNode(node.id, kbLinksAfter, qteAfter)
    if (before !== after) addReason(node.id, 'question_count')
  }

  for (const r of [
    ...(kbNodeSync.toDelete as KnowledgeBaseNodeRow[]),
    ...(kbNodeSync.toInsert as KnowledgeBaseNodeRow[]),
    ...(kbNodeSync.toUpdate as KnowledgeBaseNodeRow[]),
  ]) {
    if (r.type === 'file') addReason(r.id, 'node_fields')
  }

  const knowledgeBaseTreeChanged = isKnowledgeBaseTreeChanged(kbNodeSync)

  const deletedFileNodes = (
    kbNodeSync.toDelete as KnowledgeBaseNodeRow[]
  ).filter((n) => n.type === 'file')

  if (knowledgeBaseTreeChanged) {
    for (const node of fileNodes) {
      addReason(node.id, 'navigation')
    }
  }

  const surviving = [...reasonsByNodeId.entries()].map(([id, reasons]) => {
    const node = nodeById.get(id)!
    return {
      id,
      slug: node.slug,
      name: node.name,
      reasons: [...reasons].sort(),
    }
  })

  const removed = knowledgeBaseTreeChanged
    ? deletedFileNodes.map((node) => ({
        id: node.id,
        slug: node.slug,
        name: node.name,
        reasons: ['navigation', 'node_fields'] satisfies KbNodeRerenderReason[],
        deleted: true as const,
      }))
    : []

  return {
    kbNodesToRerender: [...surviving, ...removed].sort(
      (a, b) =>
        a.slug?.localeCompare(b.slug ?? '') ?? a.name.localeCompare(b.name),
    ),
    knowledgeBaseTreeChanged,
  }
}

export type SyncDatabaseResult = {
  stats: SyncStats
  kbNodesToRerender: KbNodeRerenderTarget[]
  knowledgeBaseTreeChanged: boolean
}

/**
 * Compares generated rows to the DB per table: DELETE removed keys, UPDATE same-key changes,
 * INSERT new keys. Delete order respects FKs; insert order is the reverse; updates run between.
 */
export async function syncDatabaseFromGenerated(
  sql: PostgresClient,
  generated: GeneratedRows,
): Promise<SyncDatabaseResult> {
  const {
    knowledgeBaseRows,
    explanationRows,
    kbNodeToExplanationRows,
    questionToExplanationRows,
    managedExplanationIds,
  } = generated

  const stats: SyncStats = {
    explanationsDeleted: 0,
    explanationsInserted: 0,
    explanationsUpdated: 0,
    knowledgeBaseNodesDeleted: 0,
    knowledgeBaseNodesInserted: 0,
    knowledgeBaseNodesUpdated: 0,
    kbNodeToExplanationDeleted: 0,
    kbNodeToExplanationInserted: 0,
    questionToExplanationDeleted: 0,
    questionToExplanationInserted: 0,
    questionToExplanationUpdated: 0,
    contentFeedbackDeleted: 0,
  }

  let kbNodesToRerender: KbNodeRerenderTarget[] = []
  let knowledgeBaseTreeChanged = false

  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PostgresClient

    const kbLinksBefore = (await tx`
      SELECT "knowledgeBaseNodeId", "explanationId", "order"
      FROM "nauka-ppla_kb_node_to_explanation"
    `) as unknown as KbNodeToExplanationRow[]

    const explanationIdsForQte = [
      ...new Set([
        ...managedExplanationIds,
        ...kbLinksBefore.map((l) => l.explanationId),
      ]),
    ]

    const qteBefore: QteLink[] =
      explanationIdsForQte.length === 0
        ? []
        : ((await tx`
            SELECT id, "questionId", "explanationId"
            FROM "nauka-ppla_question_to_explanation"
            WHERE "explanationId" IN ${tx(explanationIdsForQte)}
          `) as unknown as QteLink[])

    const kbLinkSync = await prepareSetSync(tx, {
      name: 'kb_node_to_explanation',
      fetchCurrentRows: async (t) =>
        (await t`
          SELECT "knowledgeBaseNodeId", "explanationId", "order"
          FROM "nauka-ppla_kb_node_to_explanation"
        `) as unknown as KbNodeToExplanationRow[],
      desiredRows: kbNodeToExplanationRows,
      keyOf: kbLinkKey,
      deleteRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            DELETE FROM "nauka-ppla_kb_node_to_explanation"
            WHERE "knowledgeBaseNodeId" = ${r.knowledgeBaseNodeId}
              AND "explanationId" = ${r.explanationId}
              AND "order" = ${r.order}
          `
        }
      },
      insertRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            INSERT INTO "nauka-ppla_kb_node_to_explanation" ("knowledgeBaseNodeId", "explanationId", "order")
            VALUES (${r.knowledgeBaseNodeId}, ${r.explanationId}, ${r.order})
          `
        }
      },
    })

    const qteSync = await prepareSetSync(tx, {
      name: 'question_to_explanation',
      fetchCurrentRows: async (t) => {
        if (explanationIdsForQte.length === 0) return []
        // Scope by explanation, not question: meta only lists desired links, but the DB
        // may still have rows for removed questions or stale link ids for the same explanations.
        return (await t`
          SELECT id, "questionId", "explanationId", "order", "isExtraResource"
          FROM "nauka-ppla_question_to_explanation"
          WHERE "explanationId" IN ${t(explanationIdsForQte)}
        `) as unknown as QuestionToExplanationRow[]
      },
      desiredRows: questionToExplanationRows,
      keyOf: (r) => r.id,
      replaceIfChanged: (c, d) =>
        c.questionId !== d.questionId ||
        c.explanationId !== d.explanationId ||
        c.order !== d.order ||
        c.isExtraResource !== d.isExtraResource,
      deleteRows: async (t, rows) => {
        const ids = rows.map((r) => r.id)
        for (const part of chunk(ids, 500)) {
          if (part.length === 0) continue
          await t`
            DELETE FROM "nauka-ppla_question_to_explanation"
            WHERE id IN ${t(part)}
          `
        }
      },
      insertRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            INSERT INTO "nauka-ppla_question_to_explanation" (
              id, "questionId", "explanationId", "order", "isExtraResource"
            )
            VALUES (
              ${r.id},
              ${r.questionId},
              ${r.explanationId},
              ${r.order},
              ${r.isExtraResource}
            )
          `
        }
      },
      updateRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            UPDATE "nauka-ppla_question_to_explanation"
            SET
              "questionId" = ${r.questionId},
              "explanationId" = ${r.explanationId},
              "order" = ${r.order},
              "isExtraResource" = ${r.isExtraResource}
            WHERE id = ${r.id}
          `
        }
      },
    })

    const kbNodeSync = await prepareSetSync(tx, {
      name: 'knowledge_base_node',
      fetchCurrentRows: async (t) =>
        (await t`
          SELECT id, name, type, "parentId", "order", slug
          FROM "nauka-ppla_knowledge_base_node"
        `) as unknown as KnowledgeBaseNodeRow[],
      desiredRows: knowledgeBaseRows,
      keyOf: (r) => r.id,
      replaceIfChanged: (c, d) =>
        c.name !== d.name ||
        c.type !== d.type ||
        c.parentId !== d.parentId ||
        c.order !== d.order,
      deleteRows: async (t, rows) => {
        const ids = rows.map((r) => r.id)
        for (const part of chunk(ids, 500)) {
          if (part.length === 0) continue
          await t`
            DELETE FROM "nauka-ppla_knowledge_base_node"
            WHERE id IN ${t(part)}
          `
        }
      },
      insertRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            INSERT INTO "nauka-ppla_knowledge_base_node" (id, name, type, "parentId", "order", "slug")
            VALUES (${r.id}, ${r.name}, ${r.type}, ${r.parentId}, ${r.order}, ${r.slug})
          `
        }
      },
      updateRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            UPDATE "nauka-ppla_knowledge_base_node"
            SET
              name = ${r.name},
              type = ${r.type},
              "parentId" = ${r.parentId},
              "order" = ${r.order},
              slug = ${r.slug}
            WHERE id = ${r.id}
          `
        }
      },
    })

    const kbIdsToRemove = kbNodeSync.toDelete.map(
      (r) => (r as KnowledgeBaseNodeRow).id,
    )

    const contentFeedbackCleanup: PreparedSetSync = {
      name: 'content_feedback',
      toDelete: [],
      toInsert: [],
      toUpdate: [],
      runDeletes: async (t) => {
        if (kbIdsToRemove.length === 0) return
        const del = await t`
          DELETE FROM "nauka-ppla_content_feedback"
          WHERE "knowledgeBaseNodeId" IN ${t(kbIdsToRemove)}
          RETURNING id
        `
        stats.contentFeedbackDeleted = (
          del as unknown as { id: string }[]
        ).length
      },
      runUpdates: async () => {},
      runInserts: async () => {},
    }

    const explanationSync = await prepareSetSync(tx, {
      name: 'explanation',
      fetchCurrentRows: async (t) =>
        (await t`
          SELECT id, explanation, type
          FROM "nauka-ppla_explanation"
        `) as unknown as ExplanationRow[],
      desiredRows: explanationRows,
      keyOf: (r) => r.id,
      replaceIfChanged: (c, d) =>
        c.explanation !== d.explanation || c.type !== d.type,
      deleteRows: async (t, rows) => {
        const ids = rows.map((r) => r.id)
        for (const part of chunk(ids, 500)) {
          if (part.length === 0) continue
          await t`
            DELETE FROM "nauka-ppla_explanation"
            WHERE id IN ${t(part)}
          `
        }
      },
      insertRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            INSERT INTO "nauka-ppla_explanation" (id, explanation, type)
            VALUES (${r.id}, ${r.explanation}, ${r.type})
          `
        }
      },
      updateRows: async (t, rows) => {
        for (const r of rows) {
          await t`
            UPDATE "nauka-ppla_explanation"
            SET explanation = ${r.explanation}, type = ${r.type}
            WHERE id = ${r.id}
          `
        }
      },
    })

    ;({ kbNodesToRerender, knowledgeBaseTreeChanged } =
      computeKbNodesToRerender({
        knowledgeBaseRows,
        explanationSync,
        kbLinkSync,
        qteSync,
        kbNodeSync,
        kbLinksBefore,
        qteBefore,
      }))

    const deleteStepOrder: PreparedSetSync[] = [
      kbLinkSync,
      qteSync,
      contentFeedbackCleanup,
      kbNodeSync,
      explanationSync,
    ]
    const insertStepOrder = [...deleteStepOrder].reverse()

    const byName = await runDeletesThenInserts(
      tx,
      deleteStepOrder,
      insertStepOrder,
    )

    stats.explanationsDeleted = byName.explanation?.deleted ?? 0
    stats.explanationsInserted = byName.explanation?.inserted ?? 0
    stats.explanationsUpdated = byName.explanation?.updated ?? 0
    stats.knowledgeBaseNodesDeleted = byName.knowledge_base_node?.deleted ?? 0
    stats.knowledgeBaseNodesInserted = byName.knowledge_base_node?.inserted ?? 0
    stats.knowledgeBaseNodesUpdated = byName.knowledge_base_node?.updated ?? 0
    stats.kbNodeToExplanationDeleted =
      byName.kb_node_to_explanation?.deleted ?? 0
    stats.kbNodeToExplanationInserted =
      byName.kb_node_to_explanation?.inserted ?? 0
    stats.questionToExplanationDeleted =
      byName.question_to_explanation?.deleted ?? 0
    stats.questionToExplanationInserted =
      byName.question_to_explanation?.inserted ?? 0
    stats.questionToExplanationUpdated =
      byName.question_to_explanation?.updated ?? 0
    // `contentFeedbackDeleted` is set inside `contentFeedbackCleanup.runDeletes` (RETURNING count).
  })

  return { stats, kbNodesToRerender, knowledgeBaseTreeChanged }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required')
    process.exit(1)
  }
  const metaFile = join(process.cwd(), 'meta.json')
  const metaContent = await readFile(metaFile, 'utf-8')
  const meta = metaSchema.parse(JSON.parse(metaContent))
  const sql = postgres(databaseUrl)
  try {
    const generated = await generateRows(meta, sql)
    const { stats, kbNodesToRerender, knowledgeBaseTreeChanged } =
      await syncDatabaseFromGenerated(sql, generated)

    const slugsToRerender = [
      ...new Set(
        kbNodesToRerender
          .map((x) => x.slug)
          .filter((s): s is string => s != null && s !== ''),
      ),
    ]

    console.log(
      JSON.stringify(
        {
          stats,
          knowledgeBaseTreeChanged,
          kbNodesToRerender: slugsToRerender,
          counts: {
            knowledgeBaseNodes: generated.knowledgeBaseRows.length,
            explanations: generated.explanationRows.length,
            kbNodeToExplanation: generated.kbNodeToExplanationRows.length,
            questionToExplanation: generated.questionToExplanationRows.length,
          },
        },
        null,
        2,
      ),
    )

    const rebuildUrl = process.env.REVALIDATE_URL
    const rebuildToken = process.env.REVALIDATE_TOKEN

    if (!rebuildUrl || !rebuildToken) {
      if (!rebuildUrl) console.log('REVALIDATE_URL not set')
      if (!rebuildToken) console.log('REVALIDATE_TOKEN not set')
      console.log('Skipping static page revalidation')
    } else if (slugsToRerender.length === 0 && !knowledgeBaseTreeChanged) {
      console.log('No KB pages to revalidate')
    } else {
      console.log('Revalidating', slugsToRerender, knowledgeBaseTreeChanged)
      const res = await fetch(rebuildUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: rebuildToken,
          slugs: slugsToRerender,
          navigation: knowledgeBaseTreeChanged,
        }),
      })
      if (!res.ok) {
        console.error(`Revalidate failed (${res.status}): ${await res.text()}`)
        process.exit(1)
      }
      console.log(
        `Revalidated ${slugsToRerender.length} slug(s), navigation=${knowledgeBaseTreeChanged}`,
      )
    }
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
