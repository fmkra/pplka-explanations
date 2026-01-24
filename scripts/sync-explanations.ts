/**
 * Sync explanations from this repo to the database.
 *
 * This script:
 * 1. Reads meta.json to get the mapping of files to question IDs
 * 2. Reads each explanation markdown file
 * 3. Upserts explanations in the database
 * 4. Updates questions to reference the correct explanation
 *
 * Run with: bun run scripts/sync-explanations.ts
 * Requires DATABASE_URL environment variable.
 */

import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";
import postgres from "postgres";
import XXH from "xxhashjs";
import { z } from "zod";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Error: DATABASE_URL environment variable is required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

const metaSchema = z.array(
  z.object({
    file: z.string(),
    questions: z.array(z.string()),
  })
);

/**
 * Generate a deterministic ID from a file path using xxhash.
 * This ensures the same file always gets the same explanation ID.
 */
function generateExplanationId(filePath: string): string {
  const hash = XXH.h64(filePath, 0).toString(16);
  // Format as UUID-like string for compatibility with existing schema
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-0000-000000000000`;
}

/**
 * Read all explanation files recursively from a directory.
 */
async function readExplanationsDir(
  dir: string,
  baseDir: string
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await readExplanationsDir(fullPath, baseDir);
      for (const [k, v] of subFiles) {
        files.set(k, v);
      }
    } else if (entry.name.endsWith(".md")) {
      const relativePath = relative(baseDir, fullPath);
      const content = await readFile(fullPath, "utf-8");
      files.set(relativePath, content);
    }
  }

  return files;
}

async function main() {
  const baseDir = process.cwd();
  const metaPath = join(baseDir, "meta.json");
  const explanationsDir = join(baseDir, "explanations");

  console.log("Reading meta.json...");
  const metaContent = await readFile(metaPath, "utf-8");
  const meta = metaSchema.parse(JSON.parse(metaContent));

  console.log(`Found ${meta.length} explanation entries in meta.json`);

  console.log("Reading explanation files...");
  const explanationFiles = await readExplanationsDir(explanationsDir, explanationsDir);

  console.log(`Found ${explanationFiles.size} explanation files`);

  // Track statistics
  let explanationsUpserted = 0;
  let questionsUpdated = 0;
  const questionsNotFound: string[] = [];

  // Process each meta entry
  for (const entry of meta) {
    const content = explanationFiles.get(entry.file);

    if (!content) {
      console.warn(`Warning: File not found: ${entry.file}`);
      continue;
    }

    const explanationId = generateExplanationId(entry.file);

    console.log(`Processing: ${entry.file} -> ${explanationId}`);

    // Upsert explanation
    await sql`
      INSERT INTO "nauka-ppla_explanation" (id, explanation)
      VALUES (${explanationId}, ${content})
      ON CONFLICT (id) DO UPDATE SET explanation = EXCLUDED.explanation
    `;
    explanationsUpserted++;

    // Update questions to reference this explanation
    for (const questionExternalId of entry.questions) {
      const result = await sql`
        UPDATE "nauka-ppla_question"
        SET "explanationId" = ${explanationId}
        WHERE "externalId" = ${questionExternalId}
        RETURNING id
      `;

      if (result.length > 0) {
        questionsUpdated++;
        console.log(`  Updated question: ${questionExternalId}`);
      } else {
        questionsNotFound.push(questionExternalId);
        console.warn(`  Warning: Question not found: ${questionExternalId}`);
      }
    }
  }

  // Summary
  console.log("\n--- Summary ---");
  console.log(`Explanations upserted: ${explanationsUpserted}`);
  console.log(`Questions updated: ${questionsUpdated}`);

  if (questionsNotFound.length > 0) {
    console.log(`Questions not found (${questionsNotFound.length}):`);
    for (const id of questionsNotFound) {
      console.log(`  - ${id}`);
    }
  }

  await sql.end();
  console.log("\nDone!");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
