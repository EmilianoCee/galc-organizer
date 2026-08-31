# GALC Explorer — Project Framework

## Problem

UC Berkeley's [Graphic Arts Loan Collection](https://www.lib.berkeley.edu/visit/morrison/galc) (GALC) lets students/staff browse and check out original prints. Its own site only sorts by coarse Small/Medium/Large size buckets. Goal: a personal site, built on GALC's public data, that sorts/filters by precise width and height, so paintings of the same width can be found for hanging together as a set. Shared with friends, not the public.

## Data source

[BerkeleyLibrary/galc-api](https://github.com/BerkeleyLibrary/galc-api) — a public, unauthenticated, read-only JSON:API.

- `GET /items`, `/images`, `/terms`, `/facets` need no auth or API key.
- `Item` fields (from `db/schema.rb` / `JSONAPI_ATTRS`): `title`, `artist`, `artist_url`, `date`, `description`, `dimensions`, `series`, `mms_id`, `barcode`, `circulation`, `location`, `value`, `appraisal_date`, `notes`, `reserve_date`, `suppressed`, plus relationships to `image` and `terms`, plus a derived `permalink_uri`.
- **`dimensions` is unstructured free text** — there is no numeric width/height column in the source data. GALC's own "Small/Medium/Large" filter comes from a separate `Size` facet term, not from this field. Precise sorting requires writing a parser that extracts numeric width/height from this string ourselves.
- **`circulation` is the closest thing to a checked-out flag**, but its real values/update cadence are unverified — there is no `reservations` table in this schema, meaning live loan status likely lives in Berkeley's ILS (Alma) rather than in this API. Treat any "checked out" status as a best-effort snapshot, not real-time truth.
- Production API base URL is not published in the repo/README — first implementation step is finding it (inspect network requests on the live GALC search page) and confirming there's no rate limit that a scheduled bulk pull would trip.

## Decisions made

| Question | Decision |
|---|---|
| Width/height matching | Range sliders (min/max), sorted numerically — no fuzzy grouping/clustering needed |
| Checked-out status | Best-effort snapshot from `circulation`, labeled with a "data as of [last sync]" timestamp — not claimed real-time |
| Saved/wishlist picks | Browser `localStorage`, per-device, no accounts, no backend |
| Checkout itself | Out of scope — link out to the official GALC page instead |
| Visibility | Unlisted: reachable by direct link, `noindex` + `robots.txt` disallow, not promoted/linked publicly |

## Recommended architecture

- **Static site** (e.g. Next.js static export or Astro) built from a prebuilt JSON snapshot of the collection — matches the "best-effort snapshot" decision and needs no live backend.
- **Data pipeline**: a fetch script pulls `/items`, `/images`, `/terms`; parses `dimensions` into `width_in` / `height_in` numeric fields (keeping the raw string as a display fallback for anything unparseable); writes one JSON file consumed at build time. Run on a schedule (e.g. daily via GitHub Actions) to refresh availability/new acquisitions.
- **Hosting**: Vercel/Netlify/GitHub Pages, unlisted URL, `noindex` meta + `robots.txt` disallow.
- **Wishlist**: client-side `localStorage` array of item IDs — no server component.
- **Images**: decide hotlink vs. locally-cached thumbnails before building the gallery view — these are original artist prints, not public-domain, so keep this to Small/Medium previews and attribute GALC as source rather than mirroring full-resolution files.

## Open risks to verify early (before deep implementation)

1. Find the real production API base URL.
2. Pull real sample data and inspect actual `dimensions` string formats (units, sheet-vs-frame size, ranges, blanks) before finalizing the parser.
3. Pull real sample data and check what `circulation` actually contains and how often it changes.
4. No usage terms/rate limit are documented — poll politely (e.g. once daily, not per-visitor) regardless.

## Explicitly out of scope

- Checkout/reservation flow
- User accounts / cross-device sync of saved lists
- Real-time availability guarantees
