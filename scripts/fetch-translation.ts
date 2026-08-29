/**
 * Author-time tool. Never runs in the server process.
 *
 * Builds a translation file by taking the reference translation's bank
 * (ids, references, orders) and refetching each passage in another translation
 * from bible-api.com — the same public-domain source the WEB text came from.
 *
 *   npx tsx scripts/fetch-translation.ts kjv
 *
 * Writes src/data/translations/<code>.json with `decoys: []` for every verse.
 * Decoys are a separate, human authoring step: a pool copied from another
 * translation leaks that translation's vocabulary into the tiles.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(__dirname, '..', 'src', 'data', 'translations');
const REFERENCE_FILE = path.join(DIR, 'web.json');

/** bible-api.com rate-limits; this stays comfortably under it. */
const DELAY_MS = 2500;

interface BankEntry {
  id: string;
  reference: string;
  order: number;
  text: string;
  decoys: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collapse the API's per-verse newlines into the bank's single-line form. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function fetchPassage(reference: string, translation: string): Promise<string> {
  const url = `https://bible-api.com/${encodeURIComponent(reference)}?translation=${translation}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${reference}: HTTP ${res.status}`);
  const body = (await res.json()) as { text?: string; error?: string };
  if (body.error) throw new Error(`${reference}: ${body.error}`);
  if (!body.text) throw new Error(`${reference}: no text in response`);
  return normalize(body.text);
}

async function main(): Promise<void> {
  const translation = process.argv[2]?.toLowerCase();
  if (!translation) throw new Error('usage: fetch-translation.ts <translation-code>');

  const bank = JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8')) as BankEntry[];
  const out: BankEntry[] = [];

  for (const [i, verse] of bank.entries()) {
    const text = await fetchPassage(verse.reference, translation);
    out.push({ id: verse.id, reference: verse.reference, order: verse.order, text, decoys: [] });
    console.log(`[${i + 1}/${bank.length}] ${verse.reference}`);
    if (i < bank.length - 1) await sleep(DELAY_MS);
  }

  const target = path.join(DIR, `${translation}.json`);
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${out.length} verses to ${target}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
