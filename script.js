/**
 * Fansubs.ru (Kage Project) — Russian subtitle source for Hayase.
 *
 * Site reverse-engineering notes (all verified against the live site):
 *
 *  - Encoding is windows-1251 for both request bodies and responses.
 *  - Search is a POST to `search.php` with a `query` field:
 *        POST /search.php   query=<title>&submit=<anything>
 *    The index is Latin/romaji only (Cyrillic queries return nothing) and the
 *    endpoint is flaky — it frequently returns zero results for a query that
 *    does match, so every query is retried.
 *  - `base.php?l=<letter>` is a complete, reliable A-Z index of the archive
 *    (~7.2k titles) including alternative titles, used as a fallback.
 *  - `base.php?id=N` lists releases. Each release is a form:
 *        <input type="hidden" name="srt" value="1234">
 *        <b>ТВ 1-28</b> ... <font color=#F4F4F4>ASS</font>
 *  - `base.php?srt=1234` downloads the release, but the payload is ALWAYS an
 *    archive (.rar/.7z) containing one subtitle file per episode.
 *
 * Because fansubs.ru never exposes a direct subtitle file, this extension
 * points at an unpacker "resolver" that turns a release id + episode number
 * into a real .ass/.srt URL. See resolver/README.md.
 */

const BASE = "http://fansubs.ru";

/** Subtitle formats Hayase can consume. */
const SUBTITLE_FORMATS = ["ass", "ssa", "srt", "vtt", "sub", "txt"];

const cp1251 = new TextDecoder("windows-1251");

class FansubsRuSubtitles {
  constructor() {
    this.base = BASE;
    this._searchRetries = 3;
    /**
     * Scope-bound fetch handed to us by the host as `query.fetch`. It carries
     * the CORS exemptions and credentials the platform shell grants, so it
     * must be preferred over the global one. `test()` has no query to read it
     * from and falls back to the global fetch.
     */
    this._scopedFetch = null;
    /** Per-instance memo so a single `single()` call never re-fetches a page. */
    this._memo = new Map();
  }

  // ---------------------------------------------------------------- utilities

  /**
   * Adopt the fetch the host attached to this query. Bound to the global so it
   * can be called detached, the way `fetch` normally has to be.
   */
  _useScopedFetch(query) {
    this._scopedFetch =
      query && typeof query.fetch === "function" ? query.fetch.bind(globalThis) : null;
  }

  _http() {
    return this._scopedFetch || globalThis.fetch;
  }

  async _fetch(url, init) {
    const http = this._http();
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await http(url, init);
        if (res.ok) return res;
        lastError = new Error(`fansubs.ru returned HTTP ${res.status} for ${url}`);
        // 4xx other than 429 will not get better by trying again.
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        lastError = err;
      }
      if (attempt < 2) await this._sleep(400 * (attempt + 1));
    }
    throw lastError || new Error(`fansubs.ru request failed for ${url}`);
  }

  /** Collapse concurrent/duplicate lookups of the same URL. */
  _memoized(key, produce) {
    if (this._memo.has(key)) return this._memo.get(key);
    // Keep the cache bounded: an instance can outlive many single() calls.
    if (this._memo.size >= 200) {
      this._memo.delete(this._memo.keys().next().value);
    }
    const value = Promise.resolve().then(produce);
    // Never cache a failure — a later call should be free to retry.
    value.catch(() => this._memo.delete(key));
    this._memo.set(key, value);
    return value;
  }

  async _text(url, init) {
    const res = await this._fetch(url, init);
    return cp1251.decode(await res.arrayBuffer());
  }

  /** Strip everything the site cannot search for (it indexes Latin only). */
  _toAscii(str) {
    return String(str == null ? "" : str)
      .replace(/[^\x20-\x7E]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _normalize(str) {
    return this._toAscii(str)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(the|a|an|of|to|in|no|and)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  _titleTokens(str) {
    return this._normalize(str).split(" ").filter(Boolean);
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  // ------------------------------------------------------------------ parsing

  /**
   * Parse the release rows of an anime page into structured releases.
   * Anchors on the hidden `srt` field so each block stays self-contained.
   */
  _parseReleases(html) {
    const releases = [];
    const re =
      /<input\s+type="hidden"\s+name="srt"\s+value="(\d+)"[\s\S]*?<b>([^<]*)<\/b>[\s\S]*?color=#F4F4F4>([A-Za-z0-9]+)<\/font>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const label = decodeEntities(m[2]).trim();
      const format = m[3].toLowerCase();
      if (!label || !SUBTITLE_FORMATS.includes(format)) continue;
      releases.push({
        id: m[1],
        label,
        format,
        ranges: parseEpisodeRanges(label),
        isMovie: /^Фильм/i.test(label),
      });
    }
    return releases;
  }

  /** The site links anidb.net for most titles — a free, exact id to match on. */
  _parseAniDbId(html) {
    const m = html.match(/anidb\.net\/[^"'\s]*?[?&]aid=(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  /** Titles and release-type labels as shown on search / archive pages. */
  _parseIndex(html) {
    const out = [];
    const re = /<a\s+href="base\.php\?id=(\d+)"[^>]*>(?:<b>)?([^<]+?)\s*<small>\(([^)]+)\)<\/small>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      out.push({
        id: m[1],
        title: decodeEntities(m[2]).trim(),
        type: decodeEntities(m[3]).trim(),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ network

  /**
   * POST search. The site intermittently drops results, so a zero-result
   * response is retried before being believed.
   */
  async _search(title) {
    const query = this._toAscii(title);
    if (!query) return [];
    return this._memoized(`search:${query}`, async () => {
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `query=${encodeURIComponent(query)}&submit=1`,
      };
      const attempts = Math.max(1, this._searchRetries);
      for (let i = 0; i < attempts; i++) {
        let results = [];
        try {
          const html = cp1251.decode(await (await this._fetch(`${this.base}/search.php`, init)).arrayBuffer());
          results = this._parseIndex(html);
        } catch (_) {
          results = [];
        }
        if (results.length) return results;
        if (i < attempts - 1) await this._sleep(350 * (i + 1));
      }
      return [];
    });
  }

  /**
   * Reliable fallback: pull the whole A-Z page for the title's first letter
   * and match candidates locally.
   */
  async _archiveLetter(letter) {
    return this._memoized(`letter:${letter}`, async () => {
      const html = await this._text(`${this.base}/base.php?l=${encodeURIComponent(letter)}`);
      return this._parseIndex(html);
    });
  }

  async _animePage(id) {
    return this._memoized(`anime:${id}`, async () =>
      this._text(`${this.base}/base.php?id=${encodeURIComponent(id)}`)
    );
  }

  // ------------------------------------------------------------------ matching

  /** Score a candidate title against the query's titles. 0 = no match. */
  _scoreTitle(candidate, titles) {
    const a = this._normalize(candidate);
    if (!a) return 0;
    let best = 0;
    for (const t of titles) {
      const b = this._normalize(t);
      if (!b) continue;
      if (a === b) return 100;
      if (a.startsWith(b) || b.startsWith(a)) best = Math.max(best, 70);
      const at = new Set(this._titleTokens(a));
      const bt = this._titleTokens(b);
      if (!bt.length) continue;
      let hit = 0;
      for (const w of bt) if (at.has(w)) hit++;
      const ratio = hit / bt.length;
      if (ratio >= 0.6) best = Math.max(best, Math.round(ratio * 50));
    }
    return best;
  }

  /**
   * Search strategies for a set of query titles, most specific first. The site
   * only reliably matches a short leading phrase, so those are included as
   * lower-precision fallbacks.
   */
  _queryPlan(titles) {
    const plan = [];
    const seen = new Set();
    const push = (v, weight) => {
      const q = this._toAscii(v);
      if (!q || seen.has(q)) return;
      seen.add(q);
      plan.push({ q, weight });
    };
    for (const t of titles) {
      push(t, 100);
      const words = this._toAscii(t).split(" ").filter(Boolean);
      if (words.length > 1) {
        push(words.slice(0, 2).join(" "), 80);
        push(words[0], 50);
        // Trailing word catches "Sousou no Frieren" style titles.
        const last = words[words.length - 1];
        if (last.length > 3) push(last, 40);
      }
    }
    return plan.sort((a, b) => b.weight - a.weight);
  }

  /** A-Z / 0-9 letters worth checking for a set of titles. */
  _lettersFor(titles) {
    const letters = new Set();
    for (const t of titles) {
      const first = this._toAscii(t).charAt(0).toLowerCase();
      if (/[a-z0-9]/.test(first)) letters.add(first);
    }
    return [...letters];
  }

  /**
   * Resolve an anime entry id: search first, then the archive index, then pick
   * the best-scoring candidate, optionally confirmed via AniDB id.
   */
  async _resolveAnime(query, options) {
    const titles = (query.titles || []).filter(Boolean);
    if (!titles.length) return null;

    /** @type {Map<string, {id:string, score:number, title:string}>} */
    const found = new Map();
    const consider = (entries, weight) => {
      for (const e of entries) {
        const s = this._scoreTitle(e.title, titles);
        if (s <= 0) continue;
        const prev = found.get(e.id);
        const total = s + (prev ? prev.score : 0) + weight;
        if (!prev || total > prev.score) found.set(e.id, { id: e.id, score: s, title: e.title });
      }
    };
    /** An exact title hit is good enough; stop spending requests. */
    const hasExact = () => [...found.values()].some((c) => c.score >= 100);

    for (const step of this._queryPlan(titles)) {
      consider(await this._search(step.q), step.weight / 100);
      if (hasExact() || found.size >= 12) break;
    }

    // The archive index is only consulted when search came up short.
    if (!hasExact() && options.useArchiveFallback !== false && found.size < 12) {
      for (const letter of this._lettersFor(titles)) {
        consider(await this._archiveLetter(letter), 0.5);
        if (hasExact() || found.size >= 12) break;
      }
    }

    if (!found.size) return null;

    const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 5);

    // Exact match when the caller supplied an AniDB id and the site linked one.
    if (options.verifyAniDbId !== false && query.anidbAid) {
      for (const cand of ranked) {
        const aid = this._parseAniDbId(await this._animePage(cand.id));
        if (aid && aid === query.anidbAid) return { ...cand, verified: true, anidbAid: aid };
      }
    }

    return ranked[0] || null;
  }

  // ------------------------------------------------------------------ episodes

  /** Does a release cover the requested episode? */
  _releaseCovers(release, query) {
    if (release.isMovie || /Фильм/i.test(release.label)) {
      return query.episode === 1;
    }
    const ep = query.episode;
    if (!ep) return release.ranges.length === 0;
    // Empty ranges means a named special (e.g. "Спецвыпуск (Konoha Gakuen)").
    if (!release.ranges.length) return false;
    return release.ranges.some(([a, b]) => ep >= a && ep <= b);
  }

  /** Skip releases the user asked to avoid. */
  _isExcluded(release, query) {
    const hay = `${release.label} ${release.id}`.toLowerCase();
    return (query.exclusions || []).some((x) => x && hay.includes(String(x).toLowerCase()));
  }

  /** How many episodes a release covers. */
  _span(release) {
    return release.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
  }

  _buildUrl(release, query, options) {
    const resolver = String(options.resolverBase == null ? "" : options.resolverBase).trim();
    if (!resolver || resolver.toLowerCase() === "direct") {
      return `${this.base}/base.php?srt=${encodeURIComponent(release.id)}`;
    }
    const qs = new URLSearchParams({
      srt: release.id,
      ep: String(query.episode || 1),
      fmt: release.format,
      lang: "ru",
    });
    return `${resolver.replace(/\/+$/, "")}/subtitle?${qs.toString()}`;
  }

  // -------------------------------------------------------------- public API

  async test() {
    // No query is supplied here, so there is no scoped fetch to adopt.
    this._scopedFetch = null;
    this._memo.clear();
    const res = await this._http()(this.base + "/base.php");
    if (!res.ok) throw new Error(`fansubs.ru is unreachable (HTTP ${res.status})`);
    const html = cp1251.decode(await res.arrayBuffer());
    if (!/base\.php\?id=/i.test(html) && !/base\.php\?l=/i.test(html)) {
      throw new Error("fansubs.ru responded but the page layout is unrecognised");
    }
    return true;
  }

  async single(query, options = {}) {
    this._useScopedFetch(query);
    this._searchRetries = Math.max(1, Number(options.searchRetries) || 3);

    if (typeof navigator !== "undefined" && navigator.isOnline === false) {
      throw new Error("fansubs.ru requires an internet connection");
    }

    const anime = await this._resolveAnime(query, options);
    if (!anime) return [];

    const releases = this._parseReleases(await this._animePage(anime.id));

    const preferred = String(options.preferredFormat || "any").toLowerCase();
    const usable = releases.filter((r) => this._releaseCovers(r, query) && !this._isExcluded(r, query));
    let matches = preferred === "any" ? usable.slice() : usable.filter((r) => r.format === preferred);
    if (!matches.length && preferred !== "any") matches = usable;
    if (!matches.length) return [];

    // Prefer the tightest release covering the episode, then the newest.
    matches.sort((a, b) => this._span(a) - this._span(b) || Number(b.id) - Number(a.id));

    return matches.map((r) => ({ url: this._buildUrl(r, query, options), language: "RU" }));
  }
}

// ------------------------------------------------------------------ utilities

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, " ");
}

/**
 * Turn a release label into a list of inclusive episode ranges.
 *
 *   "ТВ 184-191"                 -> [[184,191]]
 *   "ТВ 5"                       -> [[5,5]]
 *   "ТВ 1-9, 11-13, 20"          -> [[1,9],[11,13],[20,20]]
 *   "Спецвыпуск 1-22 (+4,5)"     -> [[1,22],[4,4],[5,5]]
 *   "Фильм"                      -> []          (movie, no episode number)
 *   "Спецвыпуск (Konoha Gakuen)" -> []          (named special)
 */
function parseEpisodeRanges(label) {
  const ranges = [];
  const collect = (text) => {
    const re = /(\d+)\s*(?:-\s*(\d+))?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = Number(m[1]);
      const end = m[2] != null ? Number(m[2]) : start;
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) ranges.push([start, end]);
    }
  };
  // Parenthesised extras first, then the main body, so both are captured.
  for (const m of String(label).matchAll(/\(([^)]*)\)/g)) collect(m[1]);
  collect(String(label).replace(/\([^)]*\)/g, " "));
  return ranges;
}

export default FansubsRuSubtitles;

