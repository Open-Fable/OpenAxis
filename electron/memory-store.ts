import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

export interface MemoryFact {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export interface MemoryData {
  readonly enabled: boolean;
  readonly autoExtract: boolean;
  readonly profile: string;
  readonly facts: readonly MemoryFact[];
  readonly maxFactTokens: number;
}

const STORE_DIR = path.join(homedir(), ".config", "openhub");
const STORE_PATH = path.join(STORE_DIR, "memory.json");

const MAX_FACTS = 50;
const DEFAULT_MAX_TOKENS = 150;

let cache: MemoryData | null = null;

function getWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Supprime les accents
    .replace(/[^\w\s-]/g, " ") // Supprime la ponctuation
    .split(/\s+/)
    .filter((w) => w.length >= 2); // Garde les mots significatifs
}

/**
 * Calcule un score de pertinence avancé entre une question et un fait.
 * Utilise une approche hybride : Intersection + Pondération de rareté.
 */
export function getAdvancedSimilarity(fact: string, query: string): number {
  const factWords = getWords(fact);
  const queryWords = getWords(query);

  if (factWords.length === 0 || queryWords.length === 0) return 0;

  const factSet = new Set(factWords);
  // On détecte les acronymes spécifiquement dans le texte original du fait
  const acronymes = new Set(
    fact.match(/\b[A-Z]{2,}\b/g)?.map((a) => a.toLowerCase()) || [],
  );

  let score = 0;
  let matches = 0;

  for (const qWord of queryWords) {
    if (factSet.has(qWord)) {
      matches++;

      let weight = 1.0;
      if (qWord.length > 5) weight += 0.5;
      if (qWord.length > 8) weight += 1.0;

      // Bonus si le mot matché est un acronyme/mot technique dans le fait
      if (acronymes.has(qWord)) {
        weight += 2.0;
      }

      score += weight;
    }
  }

  if (matches === 0) return 0;

  // Normalisation par la racine carrée (BM25-like normalization)
  const density = score / Math.sqrt(factWords.length * queryWords.length);

  // Bonus pour match de phrase exacte (partielle)
  if (
    fact.toLowerCase().includes(query.toLowerCase()) ||
    query.toLowerCase().includes(fact.toLowerCase())
  ) {
    return density * 2.0;
  }

  return density;
}

export function getJaccardSimilarity(textA: string, textB: string): number {
  const setA = new Set(getWords(textA));
  const setB = new Set(getWords(textB));

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

export function shouldKeepFact(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith(":")) return false; // Reject empty headers/categories
  if (trimmed.length < 15) return false; // Reject too short / vague phrases

  // Generic abstract values to reject (case-insensitive)
  const genericPhrases = [
    "la visibilité du contenu",
    "le confort d'utilisation",
    "l'accès à la marque",
    "l'intérêt pour le produit",
    "réorganisation du contenu",
    "changement de dimensions",
    "responsive nettoyage",
    "alignement correct",
    "blocs contextuels en haut",
    "modifications sur les boutons",
    "modifications sur la barre",
    "réduire les boutons",
    "réduite les boutons",
    "tailles uniformisées",
    "réduction des marges",
    "réduction des bordures",
    "dimensions compactes",
    "ajustement des dimensions",
  ];

  const lower = trimmed.toLowerCase();
  if (genericPhrases.some((p) => lower.includes(p))) {
    return false;
  }

  // Micro-CSS / styling tweaks (dimensions + styling words)
  // For example: "bouton 32x32px", "avatar 50x50px", "radius 6px"
  const hasDimension = /\d+(?:px|rem|em|pt|x\d+)/i.test(trimmed);
  const hasStyleWord =
    /\b(?:bouton|avatar|taille|largeur|hauteur|margin|padding|radius|bordure|border|dimension|svg|px|arrondi|icon|icône)s?\b/i.test(
      trimmed,
    );
  if (hasDimension && hasStyleWord) {
    return false;
  }

  return true;
}

/**
 * Parse la sortie JSON d'un modèle d'extraction en une liste de faits propre.
 * Tolérant : renvoie [] sur JSON malformé ou forme inattendue. Accepte soit un
 * tableau de strings, soit `{ facts: string[] }`.
 */
export function parseFactsFromJson(raw: string, maxFacts: number): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { facts?: unknown }).facts ?? []);
    if (!Array.isArray(list)) return [];
    return (
      list
        .filter((f): f is string => typeof f === "string")
        // Les faits extraits viennent de contenu non fiable (réponse assistant) : on
        // neutralise toute évasion du bloc <memory> injecté (retrait des balises,
        // aplatissement des sauts de ligne) avant stockage.
        .map((f) =>
          f
            .replace(/<\/?memory>/gi, "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter((f) => f.length > 0)
        .slice(0, maxFacts)
    );
  } catch {
    return [];
  }
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

async function load(): Promise<MemoryData> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MemoryData>;
    const loadedFacts = parsed.facts ?? [];

    // Auto cleanup existing facts (validation rules + Jaccard similarity deduplication)
    const filteredFacts: MemoryFact[] = [];
    for (const fact of loadedFacts) {
      if (!fact || typeof fact.text !== "string") continue;
      if (!shouldKeepFact(fact.text)) continue;

      const isDuplicate = filteredFacts.some(
        (existing) => getJaccardSimilarity(existing.text, fact.text) > 0.7,
      );
      if (!isDuplicate) {
        filteredFacts.push(fact);
      }
    }

    cache = {
      enabled: false,
      autoExtract: false,
      profile: parsed.profile ?? "",
      facts: filteredFacts,
      maxFactTokens: parsed.maxFactTokens ?? DEFAULT_MAX_TOKENS,
    };

    // If we cleaned up some facts, write back to disk to sanitize memory.json
    if (filteredFacts.length !== loadedFacts.length) {
      console.warn(
        `[memory-store] Auto-cleaned/deduplicated ${loadedFacts.length - filteredFacts.length} junk/duplicate facts from memory.json`,
      );
      // Use the atomic temp+rename writer (not a raw writeFile) so a crash mid-write
      // can't corrupt memory.json.
      await save(cache);
    }

    return cache;
  } catch {
    cache = {
      enabled: false,
      autoExtract: false,
      profile: "",
      facts: [],
      maxFactTokens: DEFAULT_MAX_TOKENS,
    };
    return cache;
  }
}

async function save(data: MemoryData): Promise<void> {
  await ensureDir();
  cache = data;
  const tmpPath = STORE_PATH + ".tmp." + randomBytes(4).toString("hex");
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, STORE_PATH);
}

// Serializes load→modify→save sequences to avoid concurrent lost-update races.
let writeLock: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function getMemory(): Promise<MemoryData> {
  return load();
}

export async function setEnabled(enabled: boolean): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    await save({ ...data, enabled });
  });
}

export async function setAutoExtract(autoExtract: boolean): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    await save({ ...data, autoExtract });
  });
}

export async function setProfile(profile: string): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    await save({ ...data, profile });
  });
}

export async function addFact(
  text: string,
  tags: readonly string[],
): Promise<MemoryFact | null> {
  if (!shouldKeepFact(text)) {
    console.warn(`[memory-store] Rejected fact due to validation rules: "${text}"`);
    return null;
  }

  return withWriteLock(async () => {
    const data = await load();

    const exactDuplicate = data.facts.find(
      (f) => f.text.toLowerCase() === text.toLowerCase(),
    );
    if (exactDuplicate) return exactDuplicate;

    // Semantic duplication check using Jaccard Similarity (limit to > 0.70)
    const semanticDuplicate = data.facts.find(
      (f) => getJaccardSimilarity(f.text, text) > 0.7,
    );
    if (semanticDuplicate) {
      console.warn(
        `[memory-store] Rejected fact as semantic duplicate of "${semanticDuplicate.text}": "${text}"`,
      );
      return semanticDuplicate;
    }

    const now = Date.now();
    const fact: MemoryFact = {
      id: randomBytes(6).toString("hex"),
      text,
      tags,
      createdAt: now,
      lastUsedAt: now,
    };

    // Sort by lastUsedAt desc and cap to MAX_FACTS (preserving most recently used)
    const sorted = [...data.facts, fact].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const capped = sorted.slice(0, MAX_FACTS);

    await save({ ...data, facts: capped });
    return fact;
  });
}

export async function removeFact(id: string): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    await save({ ...data, facts: data.facts.filter((f) => f.id !== id) });
  });
}

export async function updateFact(
  id: string,
  patch: { text?: string; tags?: readonly string[] },
): Promise<void> {
  return withWriteLock(async () => {
    const data = await load();
    await save({
      ...data,
      facts: data.facts.map((f) =>
        f.id === id ? { ...f, ...patch, lastUsedAt: Date.now() } : f,
      ),
    });
  });
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export async function buildMemoryBlock(userQuery?: string): Promise<string | null> {
  const data = await load();
  if (!data.enabled) return null;
  if (!data.profile && data.facts.length === 0) return null;

  const parts: string[] = ["<memory>"];

  if (data.profile) {
    parts.push(`profile: ${data.profile}`);
  }

  if (data.facts.length > 0) {
    let tokenBudget = data.maxFactTokens ?? DEFAULT_MAX_TOKENS;

    // On pré-calcule les scores pour éviter de recalculer pendant le tri/filtrage
    const scoredFacts = data.facts.map((f) => ({
      ...f,
      relevance: userQuery ? getAdvancedSimilarity(f.text, userQuery) : 0,
    }));

    // Tri par pertinence (ou par date si pas de query)
    if (userQuery) {
      scoredFacts.sort((a, b) => {
        if (Math.abs(a.relevance - b.relevance) > 0.001) return b.relevance - a.relevance;
        return b.lastUsedAt - a.lastUsedAt;
      });
    } else {
      scoredFacts.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    }

    const selectedFacts: string[] = [];

    for (const fact of scoredFacts) {
      const line = `- ${fact.text}`;
      const cost = approxTokens(line);

      // Filtrage intelligent : si on a déjà 5 faits pertinents, on ignore le reste du bruit
      if (userQuery && fact.relevance < 0.1 && selectedFacts.length >= 5) {
        continue;
      }

      if (cost > tokenBudget) continue;
      tokenBudget -= cost;
      selectedFacts.push(fact.text);
    }

    // Sort selected facts alphabetically to guarantee stable prompt ordering
    selectedFacts.sort();

    const lines = selectedFacts.map((text) => `- ${text}`);
    if (lines.length > 0) {
      parts.push("facts:");
      parts.push(...lines);
    }
  }

  if (parts.length === 1) return null;

  parts.push("</memory>");
  return parts.join("\n");
}
