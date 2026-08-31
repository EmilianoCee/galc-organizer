# GALC Explorer

A personal, unlisted browser for UC Berkeley's [Graphic Arts Loan Collection](https://www.lib.berkeley.edu/visit/morrison/galc) that sorts and filters by **actual inches** instead of the official site's Small / Medium / Large buckets — so you can find prints that share a width and hang them as a set.

See [SPEC.md](SPEC.md) for the problem statement and the decisions this implements.

## Quick start

```bash
npm run fetch && npm run serve
```

`fetch` pulls the collection and writes `public/data/collection.json`; `serve` puts the site on <http://localhost:4173>. The first fetch takes about ten minutes (it measures every thumbnail once — see below); later runs take under a minute.

## What the site does

- **Width and height range sliders** over precise numeric inches, plus numeric entry for exact values.
- **Match width** on any print: snaps the width filter to that print's width ±0.5" and re-sorts, which is the whole reason this exists.
- **Wall view** renders every result at one shared inches-per-pixel scale, so a candidate set lines up visually before you commit to it.
- **Shelf status** from Alma, labelled with the snapshot date — see the caveat below.
- **Saved picks** in `localStorage`, per device, no accounts.
- **Shareable filter state** in the URL hash, so you can send a friend a link to exactly the 22"-wide landscapes you were looking at.
- Grid / table / wall views, text search, and the collection's own Genre / Medium / Appearance / Decade / Size facets.

Checkout is deliberately out of scope: every print links out to its Library record.

## What we learned from the real API

The spec listed four risks to verify before building. All four are settled, and two of the answers changed the design.

**1. The production API base URL is `https://galc-api.lib.berkeley.edu`** — public, unauthenticated, JSON:API. `/items`, `/terms`, `/facets` all respond; there is no `/images` index, but `/images/:id/thumbnail.jpg` (~360px) and `/images/:id.jpg` (full scan) both serve. `?include=image,terms` and `page[size]=100` work, so the whole collection is 9 requests. 896 unsuppressed items.

**2. `dimensions` parses cleanly, but its number order is not trustworthy.** Every one of the 883 non-blank values is `<number> x <number>` plus an inch mark — though the field uses five different characters for that mark (`"`, `''`, `”`, a mojibake byte, or nothing). No fractions, no ranges, no centimetres.

The catch: the string does **not** consistently put height first. Measured against the collection's own thumbnails on a 180-item sample, the string is height-first 53% of the time — a coin flip. The two *magnitudes* are reliable (they match the image's aspect ratio to 1.6% median error), so the pipeline reads each thumbnail's intrinsic pixel size and lets the image decide which number is the height. 89% of items agree closely and are marked `high` confidence; the rest keep the image's orientation but get an "approx" badge in the UI.

This is why the build downloads thumbnails. The API sends no `Accept-Ranges`, so there is no way to read just a JPEG header — but the measurements are cached in `data/aspect-cache.json` and committed, so only genuinely new images are ever fetched again.

**3. `circulation` is dead; `meta.availability` is the real signal.** `circulation` is `null` on 895 of 896 items, and `location` on 895 of 896 — the spec's best guess does not work. But `/items` returns `meta.availability`, an mms_id → boolean map covering all 896. Reading [the API's `AvailabilityService`](https://github.com/BerkeleyLibrary/galc-api/blob/main/app/services/availability_service.rb) confirms what it is: a live Alma SRU lookup of each record's MARC `AVA$e`, cached five minutes, where `true` means "available" — on the shelf. 261 of 896 were available at first pull.

Two consequences. It is *more* authoritative than the spec assumed — but our static site still turns it into a daily snapshot, so the "as of" label stays. And `AvailabilityService` swallows Alma errors and returns `{}`, so an empty `meta.availability` means *upstream failure*, not *nothing available*; the pipeline warns loudly rather than writing a collection where everything looks checked out.

**4. No documented rate limit, so the pipeline is deliberately slow**: 400ms between item pages, 120ms between images, retries with backoff, once a day via GitHub Actions rather than per visitor.

## Group boards

A board is a shared shortlist several people nominate to and vote on. One person starts a board, sends the link, and everyone adds prints and votes yes or no; the board view ranks by score and stars the leader. Votes are one per person per print, and re-voting replaces your earlier vote rather than stacking.

This is the one part of the site that is not purely static — shared state has to live somewhere. It uses [Supabase](https://supabase.com)'s free tier, talking to its PostgREST endpoint with plain `fetch`, so there is still no SDK, no CDN script, and no build step. Updates arrive by polling every six seconds, paused while the tab is in the background and refreshed the moment you return to it.

**Setup, about two minutes:**

1. Make a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor, paste in [`supabase/schema.sql`](supabase/schema.sql), and run it. That creates three tables and their row-level security policies.
3. In Settings → API, copy the **Project URL** and the **`anon` public** key.
4. Put both into [`public/config.js`](public/config.js) and commit.

Until step 4 is done the board panel shows a short setup note and the rest of the site behaves exactly as before — nothing else depends on Supabase.

**About that key.** The anon key is designed to ship in client code; row-level security is what actually constrains it. But this repo is public, so committing the key means anyone who finds the repo can write to your boards. The tables hold only print IDs, first names, and thumbs up/down, and board IDs are 12 random characters, so the realistic worst case is a stranger scribbling on a pick list. If you would rather not have it in the repo, add the URL and key as Actions secrets and generate `config.js` at deploy time by inserting this step into `pages.yml` before the upload:

```yaml
      - name: Write Supabase config
        run: |
          cat > public/config.js <<EOF
          window.GALC_SUPABASE = {
            url: '${{ secrets.SUPABASE_URL }}',
            anonKey: '${{ secrets.SUPABASE_ANON_KEY }}'
          };
          EOF
```

That keeps the key out of the repo. It is still readable in the deployed page — unavoidable for any client-side app — so it is a real improvement, not a secret.

## Layout

```
scripts/fetch-data.mjs      the pipeline: API -> public/data/collection.json
scripts/lib/dimensions.mjs  the dimensions parser (the interesting part)
scripts/lib/jpeg.mjs        reads intrinsic size from a JPEG's SOF marker
scripts/dimensions.test.mjs node:test coverage for every real-world format
public/                     the entire site: one HTML, one CSS, two JS modules
public/boards.js            shared group boards (the only networked feature)
public/config.js            your Supabase URL + anon key, or nulls to disable
supabase/schema.sql         run once in the Supabase SQL editor
data/aspect-cache.json      image id -> [w, h], committed so builds stay cheap
.github/workflows/          daily refresh, commits the snapshot if it changed
```

No dependencies and no build step. The spec suggested Next.js or Astro; with ~900 items filtered entirely client-side from one JSON file, a framework would add a toolchain without changing what ships, so `public/` is served as-is.

## Deploying

Live at **<https://emilianocee.github.io/galc-organizer/>**.

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys `public/` on every push to `main`, and again whenever the daily refresh commits a new snapshot. It runs `npm test` and checks the snapshot is non-empty first, so a broken parser or a failed pull will not go live. `actions/configure-pages` turns Pages on by itself, so there is no switch to flip in Settings.

Any other static host works too — just point it at `public/`.

Two things keep it unlisted, per the spec: `public/robots.txt` disallows everything, and `index.html` carries `noindex, nofollow, noarchive, noimageindex`. Neither is access control. A Pages site is publicly reachable by anyone with the URL, and this repo is public, so the URL is guessable from the repo name — treat it as unlisted, not private, and don't put anything on it you would not want a stranger to read.

## Images and rights

Thumbnails are hotlinked from the Library's own API rather than mirrored, and only the ~360px previews appear in the UI; the full scan is a click-out. These are original prints under artist copyright — attribute GALC, keep it unlisted, and don't rehost the full-resolution files.

## Maintenance notes

- `npm test` covers the parser against every dimension format actually present in the collection. Run it after touching `dimensions.mjs`; the daily workflow runs it before each pull.
- If a build reports many `low` confidence items, the thumbnail measurements failed — check `data/aspect-cache.json` for `null` entries and re-run with `npm run fetch:full`.
- If a build reports 0 available, suspect Alma rather than the collection.
