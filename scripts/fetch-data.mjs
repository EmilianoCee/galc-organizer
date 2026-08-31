#!/usr/bin/env node
// Builds public/data/collection.json from the live GALC API.
//
//   node scripts/fetch-data.mjs                  # normal run
//   node scripts/fetch-data.mjs --refresh-aspects  # re-measure every image
//
// The API is public, unauthenticated and undocumented as to rate limits, so
// this polls politely: paged item fetches with a delay between pages, and image
// aspect ratios cached in data/aspect-cache.json so that after the first run we
// only download thumbnails for images we have never seen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJpegSize } from './lib/jpeg.mjs';
import { resolveDimensions } from './lib/dimensions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = process.env.GALC_API_BASE || 'https://galc-api.lib.berkeley.edu';
const OUT_FILE = path.join(ROOT, 'public', 'data', 'collection.json');
const ASPECT_CACHE = path.join(ROOT, 'data', 'aspect-cache.json');

const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 400;
const IMAGE_DELAY_MS = 120;
const MAX_RETRIES = 3;

const refreshAspects = process.argv.includes('--refresh-aspects');

main().catch((err) => {
  console.error('\nfetch-data failed:', err.message);
  process.exit(1);
});

async function main() {
  const startedAt = new Date();
  console.log(`GALC API: ${API_BASE}`);

  const { items, included, availability } = await fetchAllItems();
  console.log(`Fetched ${items.length} items, ${included.length} included records.`);

  const images = indexBy(included.filter((r) => r.type === 'image'));
  const terms = indexBy(included.filter((r) => r.type === 'term'));
  const facets = await fetchFacets();

  const aspects = await loadAspectCache();
  const measured = await measureImages(items, images, aspects);
  console.log(`Image sizes: ${measured.hits} cached, ${measured.fetched} downloaded, ${measured.failed} failed.`);
  await saveAspectCache(aspects);

  const collection = buildCollection({ items, images, terms, facets, availability, aspects, startedAt });

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(collection));
  const bytes = (await fs.stat(OUT_FILE)).size;
  report(collection, bytes);
}

// ---------------------------------------------------------------- fetching

async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      const backoff = 1000 * attempt;
      console.warn(`  retry ${attempt}/${MAX_RETRIES - 1} after ${backoff}ms: ${err.message}`);
      await sleep(backoff);
    }
  }
}

async function fetchAllItems() {
  const items = [];
  const included = [];
  const availability = {};
  let missingAvailabilityPages = 0;

  for (let page = 1; ; page++) {
    const url =
      `${API_BASE}/items?include=image,terms` +
      `&page%5Bsize%5D=${PAGE_SIZE}&page%5Bnumber%5D=${page}`;
    const body = await fetchJson(url);
    items.push(...body.data);
    included.push(...(body.included || []));

    const pageAvailability = body.meta?.availability;
    if (pageAvailability && Object.keys(pageAvailability).length) {
      Object.assign(availability, pageAvailability);
    } else {
      missingAvailabilityPages++;
    }
    progress(`page ${page} (${items.length} items)`);

    if (!body.links?.next) break;
    await sleep(PAGE_DELAY_MS);
  }
  endProgress();

  if (missingAvailabilityPages) {
    // AvailabilityService swallows Alma errors and returns {}, so an empty meta
    // is a silent upstream failure rather than "nothing is available".
    console.warn(`  WARNING: ${missingAvailabilityPages} page(s) returned no availability data.`);
  }
  return { items, included, availability };
}

async function fetchFacets() {
  const body = await fetchJson(`${API_BASE}/facets`);
  return indexBy(body.data);
}

// ------------------------------------------------------------ image sizes

async function loadAspectCache() {
  if (refreshAspects) return {};
  try {
    return JSON.parse(await fs.readFile(ASPECT_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveAspectCache(aspects) {
  await fs.mkdir(path.dirname(ASPECT_CACHE), { recursive: true });
  const sorted = Object.fromEntries(
    Object.keys(aspects)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => [k, aspects[k]])
  );
  await fs.writeFile(ASPECT_CACHE, JSON.stringify(sorted, null, 1) + '\n');
}

/**
 * The `dimensions` text does not reliably say which number is the height, so we
 * read each thumbnail's intrinsic pixel size and use that to settle it. Results
 * are cached by image id; the API serves no Range support, so an uncached image
 * costs a full ~50KB thumbnail download.
 */
async function measureImages(items, images, aspects) {
  const needed = [];
  for (const item of items) {
    const imageId = item.relationships?.image?.data?.id;
    if (!imageId) continue;
    if (aspects[imageId] === undefined) needed.push(imageId);
  }
  const unique = [...new Set(needed)];
  const hits = items.length - unique.length;
  let fetched = 0;
  let failed = 0;

  for (const [i, imageId] of unique.entries()) {
    progress(`measuring image ${i + 1}/${unique.length}`);
    try {
      const res = await fetch(`${API_BASE}/images/${imageId}/thumbnail.jpg`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const size = readJpegSize(Buffer.from(await res.arrayBuffer()));
      if (!size) throw new Error('no JPEG SOF marker');
      aspects[imageId] = [size.width, size.height];
      fetched++;
    } catch {
      aspects[imageId] = null; // remembered so we do not retry every build
      failed++;
    }
    await sleep(IMAGE_DELAY_MS);
  }
  endProgress();
  return { hits, fetched, failed };
}

function aspectOf(aspects, imageId) {
  const entry = imageId && aspects[imageId];
  if (!Array.isArray(entry)) return null;
  return { width: entry[0], height: entry[1] };
}

// ------------------------------------------------------------- assembling

function buildCollection({ items, images, terms, facets, availability, aspects, startedAt }) {
  const facetNameById = new Map(
    Object.values(facets).map((f) => [f.id, f.attributes.name])
  );

  const built = items
    .filter((item) => !item.attributes.suppressed)
    .map((item) => {
      const a = item.attributes;
      const imageId = item.relationships?.image?.data?.id || null;
      const dims = resolveDimensions(a.dimensions, aspectOf(aspects, imageId));

      const itemTerms = (item.relationships?.terms?.data || [])
        .map((ref) => terms[ref.id])
        .filter(Boolean);
      const facetValues = {};
      for (const term of itemTerms) {
        const facetName = facetNameById.get(term.relationships?.facet?.data?.id);
        if (!facetName) continue;
        (facetValues[facetName] ||= []).push(term.attributes.value);
      }
      for (const key of Object.keys(facetValues)) {
        facetValues[key] = [...new Set(facetValues[key])].sort();
      }

      return {
        id: item.id,
        title: a.title || 'Untitled',
        artist: a.artist || null,
        artist_url: a.artist_url || null,
        date: a.date || null,
        year: parseYear(a.date),
        description: a.description || null,
        series: a.series || null,
        notes: a.notes || null,
        permalink: a.permalink_uri || null,
        mms_id: a.mms_id || null,
        image_id: imageId,
        thumbnail_url: imageId ? `${API_BASE}/images/${imageId}/thumbnail.jpg` : null,
        full_url: imageId ? `${API_BASE}/images/${imageId}.jpg` : null,
        width_in: dims.width_in,
        height_in: dims.height_in,
        area_sq_in: dims.width_in && dims.height_in ? round2(dims.width_in * dims.height_in) : null,
        orientation: dims.orientation,
        dim_confidence: dims.confidence,
        dimensions_raw: dims.raw,
        available: a.mms_id in availability ? availability[a.mms_id] : null,
        facets: facetValues
      };
    });

  built.sort((x, y) => x.title.localeCompare(y.title));

  return {
    meta: {
      source: 'UC Berkeley Graphic Arts Loan Collection',
      source_url: 'https://www.lib.berkeley.edu/visit/morrison/galc',
      api_base: API_BASE,
      fetched_at: startedAt.toISOString(),
      item_count: built.length,
      availability_known: built.filter((i) => i.available !== null).length,
      available_count: built.filter((i) => i.available === true).length,
      dimensioned_count: built.filter((i) => i.width_in !== null).length
    },
    facets: buildFacetIndex(built),
    items: built
  };
}

function buildFacetIndex(items) {
  const index = {};
  for (const item of items) {
    for (const [facet, values] of Object.entries(item.facets)) {
      const bucket = (index[facet] ||= {});
      for (const value of values) bucket[value] = (bucket[value] || 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(index).map(([facet, counts]) => [
      facet,
      Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
    ])
  );
}

function parseYear(date) {
  if (typeof date !== 'string') return null;
  const match = date.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match ? Number(match[1]) : null;
}

// ------------------------------------------------------------------ output

function report(collection, bytes) {
  const m = collection.meta;
  const byConfidence = {};
  for (const item of collection.items) {
    byConfidence[item.dim_confidence] = (byConfidence[item.dim_confidence] || 0) + 1;
  }
  const widths = collection.items.map((i) => i.width_in).filter(Boolean).sort((a, b) => a - b);

  console.log('');
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} (${(bytes / 1024).toFixed(0)} KB)`);
  console.log(`  items                ${m.item_count}`);
  console.log(`  with dimensions      ${m.dimensioned_count}`);
  console.log(`  dimension confidence ${JSON.stringify(byConfidence)}`);
  console.log(`  availability known   ${m.availability_known} (${m.available_count} available now)`);
  if (widths.length) {
    console.log(`  width range          ${widths[0]}" - ${widths[widths.length - 1]}"`);
  }
  console.log(`  fetched at           ${m.fetched_at}`);
}

function indexBy(records) {
  const out = {};
  for (const record of records) out[record.id] = record;
  return out;
}

// Progress is a redrawn single line on a terminal, and silent in CI where it
// would otherwise fill the log with one line per image.
let progressActive = false;
function progress(text) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\r  ${text}   `);
  progressActive = true;
}

function endProgress() {
  if (!progressActive) return;
  process.stdout.write('\n');
  progressActive = false;
}

const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
