import { readFile, readdir } from 'fs/promises'
import { join, relative } from 'path'
import postgres from 'postgres'
import { v5 as uuidv5, v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

const BRANCH = 'feat/profil-skrzydla'
const SVGS_BASE_URL = `https://raw.githubusercontent.com/fmkra/pplka-explanations/refs/heads/${BRANCH}/explanations/`

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required')
  process.exit(1)
}

const sql = postgres(DATABASE_URL)

// meta.json: question external ID -> ordered array of explanation file paths
const metaSchema = z.record(z.string(), z.array(z.string()))

/**
 * Generate a deterministic UUID v5 from a file path.
 * This ensures the same file always gets the same explanation ID.
 */
function generateExplanationId(filePath: string): string {
  return uuidv5(filePath, uuidv5.URL)
}

async function readExplanationsDir(
  dir: string,
  baseDir: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const subFiles = await readExplanationsDir(fullPath, baseDir)
      for (const [k, v] of subFiles) {
        files.set(k, v)
      }
    } else if (entry.name.endsWith('.md')) {
      const relativePath = relative(baseDir, fullPath)
      const content = await readFile(fullPath, 'utf-8')
      files.set(relativePath, content)
    } else if (entry.name.endsWith('.svg')) {
      const relativePath = relative(baseDir, fullPath)
      const svgUrl = `${SVGS_BASE_URL}${encodeURIComponent(relativePath)}`
      files.set(relativePath, `![](${svgUrl})`)
    }
  }

  return files
}

async function main() {
  const baseDir = process.cwd()
  const metaPath = join(baseDir, 'meta.json')
  const explanationsDir = join(baseDir, 'explanations')

  console.log('Reading meta.json (full sync)...')
  const metaContent = await readFile(metaPath, 'utf-8')
  const meta = metaSchema.parse(JSON.parse(metaContent))

  const questionIds = Object.keys(meta)
  console.log(`Found ${questionIds.length} questions in meta.json`)

  // All unique explanation file paths (order per question is in meta values)
  const uniqueFiles = [...new Set(questionIds.flatMap((q) => meta[q]))]
  console.log(`Found ${uniqueFiles.length} unique explanation file paths`)

  console.log('Reading explanation files (full sync)...')
  const explanationFiles = await readExplanationsDir(
    explanationsDir,
    explanationsDir,
  )
  console.log(`Found ${explanationFiles.size} explanation files on disk`)

  // 1) Upsert each unique explanation (one file = one explanation)
  let explanationsUpserted = 0
  for (const file of uniqueFiles) {
    const content = explanationFiles.get(file)
    if (!content) {
      console.warn(`Warning: File not found: ${file}`)
      continue
    }
    const explanationId = generateExplanationId(file)
    await sql`
      INSERT INTO "nauka-ppla_explanation" (id, explanation)
      VALUES (${explanationId}, ${content})
      ON CONFLICT (id) DO UPDATE SET explanation = EXCLUDED.explanation
    `
    explanationsUpserted++
  }
  console.log(`Upserted ${explanationsUpserted} explanations`)

  // 2) For each question: replace its explanation links with ordered list from meta
  let linksInserted = 0
  const questionsNotFound: string[] = []

  for (const questionExternalId of questionIds) {
    const files = meta[questionExternalId]
    if (!files.length) continue

    const [question] = await sql`
      SELECT id FROM "nauka-ppla_question"
      WHERE "externalId" = ${questionExternalId}
    `
    if (!question) {
      questionsNotFound.push(questionExternalId)
      console.warn(`Warning: Question not found: ${questionExternalId}`)
      continue
    }

    await sql`
      DELETE FROM "nauka-ppla_question_to_explanation"
      WHERE "questionId" = ${question.id}
    `

    for (let order = 0; order < files.length; order++) {
      const file = files[order]
      const content = explanationFiles.get(file)
      if (!content) {
        console.warn(`Warning: File not found: ${file}, skipping link`)
        continue
      }
      const explanationId = generateExplanationId(file)
      const id = uuidv4()
      await sql`
        INSERT INTO "nauka-ppla_question_to_explanation" ("questionId", "explanationId", "order", "id")
        VALUES (${question.id}, ${explanationId}, ${order}, ${id})
      `
      linksInserted++
    }
    console.log(
      `  Linked ${files.length} explanations to question ${questionExternalId}`,
    )
  }

  console.log('\n--- Full Sync Summary ---')
  console.log(`Explanations upserted: ${explanationsUpserted}`)
  console.log(`Question–explanation links inserted: ${linksInserted}`)

  if (questionsNotFound.length > 0) {
    console.log(`Questions not found (${questionsNotFound.length}):`)
    for (const id of questionsNotFound) {
      console.log(`  - ${id}`)
    }
  }

  await sql.end()
  console.log('\nFull sync done!')
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
