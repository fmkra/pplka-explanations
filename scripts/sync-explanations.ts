/**
 * Incremental sync of explanations to the database.
 *
 * Compares the current meta.json with the previous commit's version
 * and only processes entries that changed. Also detects changed .md files.
 *
 * Operations:
 * - Removed entries: unlinks questions and deletes the explanation
 * - Added entries: inserts explanation and links questions
 * - Modified entries: updates explanation content and question links
 * - Changed .md files: updates explanation content
 *
 * Run with: bun run scripts/sync-explanations.ts
 * Requires DATABASE_URL environment variable.
 * Requires fetch-depth >= 2 in CI so HEAD~1 is available.
 */

import { readFile } from 'fs/promises'
import { execSync } from 'child_process'
import { join } from 'path'
import postgres from 'postgres'
import { v5 as uuidv5 } from 'uuid'
import { z } from 'zod'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required')
  process.exit(1)
}

const sql = postgres(DATABASE_URL)

const metaSchema = z.array(
  z.object({
    file: z.string(),
    questions: z.array(z.string()),
  }),
)

type MetaEntry = z.infer<typeof metaSchema>[number]

function generateExplanationId(filePath: string): string {
  return uuidv5(filePath, uuidv5.URL)
}

function getOldMeta(): MetaEntry[] {
  try {
    const content = execSync('git show HEAD~1:meta.json', {
      encoding: 'utf-8',
    })
    return metaSchema.parse(JSON.parse(content))
  } catch {
    console.log('No previous meta.json found, treating as empty')
    return []
  }
}

function getChangedExplanationFiles(): Set<string> {
  try {
    const output = execSync(
      'git diff --name-only HEAD~1 HEAD -- explanations/',
      { encoding: 'utf-8' },
    )
    return new Set(
      output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((f) => f.replace(/^explanations\//, '')),
    )
  } catch {
    return new Set()
  }
}

async function main() {
  const baseDir = process.cwd()
  const explanationsDir = join(baseDir, 'explanations')

  console.log('Reading current meta.json...')
  const metaContent = await readFile(join(baseDir, 'meta.json'), 'utf-8')
  const newMeta = metaSchema.parse(JSON.parse(metaContent))

  console.log('Reading previous meta.json from git...')
  const oldMeta = getOldMeta()

  const changedFiles = getChangedExplanationFiles()
  console.log(`Changed explanation files: ${changedFiles.size}`)

  const oldMap = new Map(oldMeta.map((e) => [e.file, e]))
  const newMap = new Map(newMeta.map((e) => [e.file, e]))

  const removed = oldMeta.filter((e) => !newMap.has(e.file))
  const added = newMeta.filter((e) => !oldMap.has(e.file))
  const kept = newMeta.filter((e) => oldMap.has(e.file))

  const questionsModified = kept.filter((e) => {
    const old = oldMap.get(e.file)!
    return (
      JSON.stringify([...old.questions].sort()) !==
      JSON.stringify([...e.questions].sort())
    )
  })

  // Entries where only the .md content changed (not already covered by add/modify)
  const alreadyHandled = new Set([
    ...added.map((e) => e.file),
    ...questionsModified.map((e) => e.file),
  ])
  const contentOnly = kept.filter(
    (e) => !alreadyHandled.has(e.file) && changedFiles.has(e.file),
  )

  const toUpsert = [...added, ...questionsModified, ...contentOnly]

  console.log(`\nDiff summary:`)
  console.log(`  Removed: ${removed.length}`)
  console.log(`  Added: ${added.length}`)
  console.log(`  Questions modified: ${questionsModified.length}`)
  console.log(`  Content-only changes: ${contentOnly.length}`)

  if (
    removed.length === 0 &&
    toUpsert.length === 0 &&
    questionsModified.length === 0
  ) {
    console.log('\nNothing to do.')
    await sql.end()
    return
  }

  const stats = {
    deleted: 0,
    upserted: 0,
    questionsLinked: 0,
    questionsUnlinked: 0,
    questionsNotFound: [] as string[],
  }

  // --- Removed entries: unlink questions, delete explanation ---
  for (const entry of removed) {
    const explanationId = generateExplanationId(entry.file)
    console.log(`[DEL] ${entry.file} (${explanationId})`)

    for (const qid of entry.questions) {
      await sql`
        UPDATE "nauka-ppla_question"
        SET "explanationId" = NULL
        WHERE "externalId" = ${qid} AND "explanationId" = ${explanationId}
      `
      stats.questionsUnlinked++
    }

    await sql`DELETE FROM "nauka-ppla_explanation" WHERE id = ${explanationId}`
    stats.deleted++
  }

  // --- Added / modified / content-changed entries: upsert explanation, link questions ---
  for (const entry of toUpsert) {
    const explanationId = generateExplanationId(entry.file)
    const filePath = join(explanationsDir, entry.file)

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      console.warn(`  Warning: File not found: ${entry.file}`)
      continue
    }

    console.log(`[UPS] ${entry.file} -> ${explanationId}`)

    await sql`
      INSERT INTO "nauka-ppla_explanation" (id, explanation)
      VALUES (${explanationId}, ${content})
      ON CONFLICT (id) DO UPDATE SET explanation = EXCLUDED.explanation
    `
    stats.upserted++

    for (const qid of entry.questions) {
      const result = await sql`
        UPDATE "nauka-ppla_question"
        SET "explanationId" = ${explanationId}
        WHERE "externalId" = ${qid}
        RETURNING id
      `

      if (result.length > 0) {
        stats.questionsLinked++
      } else {
        stats.questionsNotFound.push(qid)
      }
    }
  }

  // --- Modified entries: unlink questions that were removed from the entry ---
  for (const entry of questionsModified) {
    const old = oldMap.get(entry.file)!
    const explanationId = generateExplanationId(entry.file)
    const newQuestions = new Set(entry.questions)
    const removedQuestions = old.questions.filter((q) => !newQuestions.has(q))

    for (const qid of removedQuestions) {
      console.log(`  [UNLINK] ${qid} from ${entry.file}`)
      await sql`
        UPDATE "nauka-ppla_question"
        SET "explanationId" = NULL
        WHERE "externalId" = ${qid} AND "explanationId" = ${explanationId}
      `
      stats.questionsUnlinked++
    }
  }

  console.log('\n--- Summary ---')
  console.log(`Explanations deleted: ${stats.deleted}`)
  console.log(`Explanations upserted: ${stats.upserted}`)
  console.log(`Questions linked: ${stats.questionsLinked}`)
  console.log(`Questions unlinked: ${stats.questionsUnlinked}`)

  if (stats.questionsNotFound.length > 0) {
    console.log(`Questions not found (${stats.questionsNotFound.length}):`)
    for (const id of stats.questionsNotFound) {
      console.log(`  - ${id}`)
    }
  }

  await sql.end()
  console.log('\nDone!')
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
