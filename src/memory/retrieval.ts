import { db } from "./db.js";
import { getEmbedding } from "./embeddings.js";

type ExpertRow = {
  slug: string;
  role: string | null;
  content: string | null;
  category: string | null;
  embedding: Uint8Array | null;
};

type UserMemoryRow = {
  id: number;
  memory_key: string;
  content: string;
  tags: string | null;
  embedding: Uint8Array | null;
};

export type RetrievedPersona = {
  slug: string;
  role: string;
  content: string;
  category: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
};

export type RetrievedUserContext = {
  id: number;
  key: string;
  content: string;
  tags: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
};

export type CombinedRetrievalResult = {
  persona: RetrievedPersona | null;
  userContext: RetrievedUserContext[];
  query: string;
};

export async function retrieveExpertAndUserContext(
  userInput: string,
  providedVector?: number[]
): Promise<CombinedRetrievalResult> {
  const query = userInput.trim();
  if (!query) {
    throw new Error("userInput must be a non-empty string.");
  }

  const queryVector = providedVector ?? (await getEmbedding(query));
  const queryKeywords = tokenize(query);

  const persona = retrievePersona(queryVector, queryKeywords);
  const userContext = retrieveUserContext(queryVector, queryKeywords);

  return { persona, userContext, query };
}

function retrievePersona(queryVector: number[], keywords: string[]): RetrievedPersona | null {
  const rows = db
    .prepare(
      `SELECT slug, role, content, category, embedding
       FROM expert_library
       LIMIT 200`
    )
    .all() as ExpertRow[];

  let best: RetrievedPersona | null = null;

  for (const row of rows) {
    const text = `${row.slug} ${row.role ?? ""} ${row.content ?? ""} ${row.category ?? ""}`;
    const keywordScore = scoreKeywords(text, keywords);
    const vectorScore = scoreVector(queryVector, row.embedding);
    const score = blendScore(vectorScore, keywordScore);

    if (!best || score > best.score) {
      best = {
        slug: row.slug,
        role: row.role ?? "",
        content: row.content ?? "",
        category: row.category ?? "",
        score,
        vectorScore,
        keywordScore,
      };
    }
  }

  return best;
}

function retrieveUserContext(queryVector: number[], keywords: string[]): RetrievedUserContext[] {
  const rows = db
    .prepare(
      `SELECT id, memory_key, content, tags, embedding
       FROM user_memory
       ORDER BY updated_at DESC
       LIMIT 300`
    )
    .all() as UserMemoryRow[];

  return rows
    .map((row): RetrievedUserContext => {
      const text = `${row.memory_key} ${row.content} ${row.tags ?? ""}`;
      const keywordScore = scoreKeywords(text, keywords);
      const vectorScore = scoreVector(queryVector, row.embedding);
      const score = blendScore(vectorScore, keywordScore);
      return {
        id: row.id,
        key: row.memory_key,
        content: row.content,
        tags: row.tags ?? "",
        score,
        vectorScore,
        keywordScore,
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function decodeFloat32Vector(bytes: Uint8Array | null): Float32Array | null {
  if (!bytes) return null;
  if (bytes.byteLength % 4 !== 0) return null;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function scoreVector(queryVector: number[], rawEmbedding: Uint8Array | null): number {
  const vec = decodeFloat32Vector(rawEmbedding);
  if (!vec) return 0;
  if (vec.length !== queryVector.length) return 0;
  return dotProduct(queryVector, vec);
}

function scoreKeywords(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw)) hits += 1;
  }
  return hits / keywords.length;
}

function blendScore(vectorScore: number, keywordScore: number): number {
  // Vector-first blend with keyword relevance as a stabilizer.
  return vectorScore * 0.75 + keywordScore * 0.25;
}

function tokenize(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((t) => t.length >= 3)
    )
  ).slice(0, 12);
}

function dotProduct(a: number[], b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
