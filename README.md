# Fansubs.ru subtitle extension for Hayase

Russian fansub subtitles from [fansubs.ru](http://fansubs.ru) (Kage Project),
packaged as a Hayase `subtitle` extension.

```
manifest.json      extension metadata + user options
script.js          the extension itself (SubtitleSource)
resolver/          unpacker service — see "Why a resolver is required"
test-extension.mjs local harness that runs script.js against the live site
```

## Install

Hayase installs extensions from a **repository manifest** — a URL returning a
JSON **array**. It does not load a bare `manifest.json` on its own, so the file
that matters for installation is `index.json`; `manifest.json` is kept as the
per-extension metadata reference from the API docs.

1. Put `index.json` and `script.js` on any static host with CORS enabled
   (GitHub works). Update the `code` and `update` fields in `index.json` to
   your own references.
2. Start the resolver (see below).
3. In Hayase: **Settings → Extensions → Repositories**, paste the URL of your
   `index.json`, click **Import Extensions**.
4. Go to the **Extensions** tab, toggle **Fansubs.ru (Russian)** on, and set
   **resolverBase** to your resolver's address.

Hayase re-polls the manifest on every launch, so bumping `version` and pushing
updates the extension without re-importing.

**The default export must be an instance, not the class.** Hayase does
`mod = module.default` and then calls `mod.test()` / `mod.single(...)`
directly, so the export has to be an instance:

```js
export default new FansubsRuSubtitles();   // correct
export default FansubsRuSubtitles;         // silently fails
```

Exporting the class makes every call throw on an unbound method. That
rejection is swallowed by `downloadScripts`, which collects the id into
`invalidIDs` and continues — so the import reports **nothing** and the
extension simply never appears. The reference extensions use
`export default new class SubsPlease { ... }()`.

## Manifest gotchas

Two fields behave in ways the type definitions do not describe. Both cost a
failed import before they were found.

**`url` must be base64, not a plain URL.** Hayase decodes it before use:

```ts
const urls = configs.filter(c => !!c.url).map(c => atob(c.url!))
await this.codeManager.enableCORS(urls)
```

`atob` is called *before* `enableCORS`, whose own error handling is wrapped in
a `try/catch` — so a plain URL aborts the whole import with:

```
Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.
```

The type comment calls it `// URL to enable CORS on the extension's API`, which
reads as a plain URL, but the implementation wants base64. The official
`LetMeGetAByte/Hayase-Extensions` entries omit `url` entirely, which is why they
never hit this. `aHR0cDovL2ZhbnN1YnMucnU=` is `http://fansubs.ru`.

**`update` and `code` accept a `gh:` prefix.** Hayase rewrites these through
`esm.sh`, which resolves by commit and therefore is not subject to the CDN
caching that makes `raw.githubusercontent.com` serve a stale manifest for a
while after a push:

```json
"update": "gh:torkley/Hayase-extensions",
"code":   "gh:torkley/Hayase-extensions/script"
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `resolverBase` | `http://localhost:8787` | Resolver URL. Set to `direct` to return raw fansubs.ru archive URLs instead. |
| `preferredFormat` | `any` | Restrict to `ass`, `ssa` or `srt`; falls back to any if nothing matches. |
| `searchRetries` | `3` | Retries for the search endpoint, which drops results intermittently. |
| `useArchiveFallback` | `true` | Browse the A–Z index when search returns nothing. |
| `verifyAniDbId` | `true` | Confirm the candidate via the AniDB id the site links, when the query supplies one. |

## Why a resolver is required

Hayase's subtitle contract is:

```ts
interface SubtitleResult {
  url: string;      // direct URL to VTT, SRT, ASS, SSA or TXT
  language: string;
}
```

fansubs.ru has **no** endpoint that serves a single subtitle file. Downloading
any release always yields an archive:

```
GET http://fansubs.ru/base.php?srt=13364
Content-Disposition: attachment; filename="[yss]_sousou_no_frieren_(13364).rar"
```

This was checked across 40 releases spread over the whole archive: every single
response was `.rar` or `.7z`, never a loose subtitle. Worse, one release packs
an entire run of episodes into a single archive — release `13364` is "ТВ 1-28"
and holds 28 separate `.ass` files. So a plain extension can neither produce a
valid `url` nor pick the right episode out of the payload.

The resolver closes that gap: it downloads the release, extracts the entry
matching the requested episode, and serves that one file. Set
`resolverBase: "direct"` to bypass it if your player happens to accept archives.

## Resolver

```bash
cd resolver
node server.js            # http://127.0.0.1:8787
PORT=9000 node server.js  # different port
```

No npm dependencies — Node's built-in `fetch` plus a local 7-Zip installation.
Verify with `GET /health`, then try a real release:

```bash
curl "http://127.0.0.1:8787/subtitle?srt=13364&ep=7"
# X-Source-Entry: [SubsPlease] Sousou no Frieren - 07 (720p) [24255A91].ass
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address. |
| `FANSUBS_BASE` | `http://fansubs.ru` | Upstream site. |
| `SEVENZIP` | `7z` | Path to the 7-Zip binary. |
| `CACHE_TTL_MS` | `600000` | Extracted-subtitle cache lifetime. |

The extension must be able to reach the resolver, so either run both on the
same machine, or expose the resolver over the network and point `resolverBase`
at its public address. It binds to `127.0.0.1` by default; set `HOST=0.0.0.0` to
accept remote connections (it has no authentication, so keep it on a trusted
network or behind a reverse proxy).

## How the extension searches

The site is old-school PHP in **windows-1251** and behaves in a few ways that
matter:

- **Search is a POST**, not a GET — `POST /search.php` with a `query` field.
  `search.php?go=quick&quick_search=1&keywords=…` returns 404.
- **The index is Latin/romaji only.** Cyrillic queries return zero results
  whether the body is sent as windows-1251 or UTF-8, so the extension strips
  non-ASCII before searching and matches Russian titles locally instead.
- **Multi-word queries often fail.** "Frieren" matches, but the full
  "Sousou no Frieren" does not. The extension therefore walks a ladder of
  queries — full title, first two words, first word, last word — and stops as
  soon as it has an exact title hit.
- **Search is flaky**: the same query returns 21 results, then 0, minutes
  apart. Every query is retried, and an empty result is never trusted.
- **`base.php?l=<letter>` is the reliable index** (~7,200 titles, alternative
  titles included) and backs up search when search comes up empty.

Candidate titles are scored locally, and when the query carries an `anidbAid`
the extension cross-checks it against the `anidb.net` link on the anime page —
that upgrades a fuzzy title match to an exact id match.

## Release labels

`query.episode` is matched against the ranges parsed out of the release label:

| Label | Ranges |
| --- | --- |
| `ТВ 184-191` | `[[184,191]]` |
| `ТВ 5` | `[[5,5]]` |
| `ТВ 1-9, 11-13, 20` | `[[1,9],[11,13],[20,20]]` |
| `Спецвыпуск 1-22 (+4,5)` | `[[1,22],[4,4],[5,5]]` |
| `Фильм` | `[]` — treated as episode 1 |
| `Спецвыпуск (Konoha Gakuen)` | `[]` — named special, never matches a numbered episode |

`query.exclusions` is applied to every release before results are returned, and
when several releases match, the one covering the fewest episodes wins, so a
tight single-episode release is preferred over a 28-episode batch.

## Episode selection inside the archive

The resolver has to pick one file out of the archive. Numbers touching letters
are ignored, which discards `(720p)` and the CRC hashes fansubs append:

```
[SubsPlease] Sousou no Frieren - 07 (720p) [24255A91].ass   -> episode 7
[Erai-raws]  Sousou no Frieren - 12 [1080p][Multi Sub].ass  -> episode 12
Show.E07.1080p.srt                                          -> episode 7
Naruto_190_[39119B6C].srt                                   -> episode 190
```

The lookbehind on the `E05` form is load-bearing: without it the `E7` inside the
hash `[0E7D2C49]` is read as "episode 7" and returns the wrong subtitle.
Resolution numbers and four-digit years are filtered out as well.

Matching also runs on the **base name only**. Release archives are frequently
organised into one folder per series, and that folder name carries its own
range:

```
Attak on Titan 01-07\[gg]_Shingeki_no_Kyojin_-_02_[0B164A9D]_rus.ass
```

If the folder path were included, the `01` and `07` from `Attak on Titan 01-07`
would be added to every file's candidate set, making episode 1 ambiguous between
the `01` and `02` files — and the tie-break silently returned episode 2.

## Testing

```bash
node test-extension.mjs      # needs the resolver running for the URLs to resolve
```

The harness injects a plain `fetch`, standing in for the one Hayase provides to
the worker sandbox, and runs real queries for Frieren, Naruto and Attack on
Titan.

Verified against the live site while building this:

| Check | Result |
| --- | --- |
| Releases sampled across the archive | 40/40 served `.rar`/`.7z`, never a loose file |
| Episode mapping, Frieren "ТВ 1-28" | ep 1, 7, 13, 23, 28 each returned the right file |
| Nested-folder archive (Attack on Titan) | ep 1–7 each returned the right file |
| Format coverage | `.ass`, `.srt` and `.7z` releases all resolve |
| Charset | UTF-8 and windows-1251 files both detected and labelled correctly |
| Bad input | `?srt=abc` → 400, `?ep=999` → 502 with a descriptive message |

## Notes and limits

- fansubs.ru is **HTTP only** and does not send CORS headers. Requests go
  through the resolver, so the browser never talks to the site directly; the
  manifest's `url` field still needs to list the host for the host shell to
  permit it.
- The site rate-limits aggressively under bursts. `rateLimit: 1` is set in the
  manifest and every request is retried with backoff; a few concurrent lookups
  can still draw `fetch failed`, which surfaces as an error rather than a wrong
  answer.
- Cyrillic subtitle files are served in windows-1251 as often as UTF-8. The
  resolver sniffs each file and sets the charset accordingly, so players render
  Russian text correctly either way.
- `accuracy` is `medium`: discovery is title-based, then id-verified when an
  AniDB id is available.

