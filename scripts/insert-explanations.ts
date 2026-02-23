import { readFile, readdir } from 'fs/promises'
import { join, relative } from 'path'
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

  console.log(`Found ${meta.length} explanation entries in meta.json`)

  console.log('Reading explanation files (full sync)...')
  const explanationFiles = await readExplanationsDir(
    explanationsDir,
    explanationsDir,
  )

  console.log(`Found ${explanationFiles.size} explanation files`)

  let explanationsUpserted = 0
  let questionsUpdated = 0
  const questionsNotFound: string[] = []

  for (const entry of meta) {
    const content = explanationFiles.get(entry.file)

    if (!content) {
      console.warn(`Warning: File not found: ${entry.file}`)
      continue
    }

    const explanationId = generateExplanationId(entry.file)

    console.log(`[FULL] Processing: ${entry.file} -> ${explanationId}`)

    await sql`
      INSERT INTO "nauka-ppla_explanation" (id, explanation)
      VALUES (${explanationId}, ${content})
      ON CONFLICT (id) DO UPDATE SET explanation = EXCLUDED.explanation
    `
    explanationsUpserted++

    for (const questionExternalId of entry.questions) {
      const result = await sql`
        UPDATE "nauka-ppla_question"
        SET "explanationId" = ${explanationId}
        WHERE "externalId" = ${questionExternalId}
        RETURNING id
      `

      if (result.length > 0) {
        questionsUpdated++
        console.log(`  [FULL] Updated question: ${questionExternalId}`)
      } else {
        questionsNotFound.push(questionExternalId)
        console.warn(
          `  [FULL] Warning: Question not found: ${questionExternalId}`,
        )
      }
    }
  }

  console.log('\n--- Full Sync Summary ---')
  console.log(`Explanations upserted: ${explanationsUpserted}`)
  console.log(`Questions updated: ${questionsUpdated}`)

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
