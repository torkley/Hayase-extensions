#!/usr/bin/env node
/**
 * fansubs.ru unpacker resolver.
 *
 * fansubs.ru only ever serves subtitle *archives* (.rar/.7z) from
 * `base.php?srt=<id>`, and a single release usually packs a whole run of
 * episodes into one file. Hayase, however, needs a direct URL to one
 * .ass/.srt/.ssa file. This service bridges the gap:
 *
 *     GET /subtitle?srt=<releaseId>&ep=<episodeNumber>
 *       -> downloads the release archive
 *       -> picks the entry matching the requested episode
 *       -> streams that single subtitle file back
 *
 * It has no npm dependencies: Node's built-in fetch does the HTTP and the
 * locally installed 7-Zip does the unpacking.
 *
 *   node server.js            # listens on http://localhost:8787
 *   PORT=9000 node server.js
 *   SEVENZIP=/path/to/7z node server.js
 */

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const SOURCE = process.env.FANSUBS_BASE || "http://fansubs.ru";
const SEVENZIP = process.env.SEVENZIP || "7z";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 10 * 60 * 1000;
const MAX_EPISODE = 10000;

const SUBTITLE_EXT = new Set([".ass", ".ssa", ".srt", ".vtt", ".sub", ".txt"]);

/** Numbers that appear in release names but are never episode numbers. */
const NOISE_NUMBERS = new Set([240, 360, 480, 540, 576, 720, 1080, 1440, 2160, 4320]);

/** @type {Map<string, {expires:number, body:Buffer, type:string, name:string}>} */
const cache = new Map();

// ----------------------------------------------------------------- utilities

function sevenZip() {
  return execFileAsync(SEVENZIP, ["i"], { windowsHide: true }).then(
    () => true,
    () => {
      throw new Error(
        `Cannot run 7-Zip ("${SEVENZIP}"). Install 7-Zip or set the SEVENZIP env var to its full path.`
      );
    }
  );
}

function isPlausibleEpisode(n) {
  return (
    Number.isFinite(n) &&
    n > 0 &&
    n < MAX_EPISODE &&
    !NOISE_NUMBERS.has(n) &&
    !/^(19|20)\d{2}$/.test(String(n))
  );
}

/**
 * Every number in a filename that could plausibly be an episode number.
 *
 * Numbers touching letters are ignored, which rules out "720p" and the CRC
 * hashes fansubs append (`[820FC793]`), while still allowing `Show - 01.ass`
 * and `Show_01.ass`. The `E05` form gets the same protection: without the
 * lookbehind, the `E7` inside a hash like `[0E7D2C49]` reads as episode 7.
 */
function episodeCandidates(name) {
  const out = new Set();
  const add = (v) => {
    const n = Number(v);
    if (isPlausibleEpisode(n)) out.add(n);
  };
  for (const m of String(name).matchAll(/(?<![A-Za-z0-9])0*(\d{1,4})(?![A-Za-z0-9])/g)) add(m[1]);
  for (const m of String(name).matchAll(
    /(?<![A-Za-z0-9])e(?:p|pisode)?[\s._-]*0*(\d{1,4})(?![0-9])/gi
  )) {
    add(m[1]);
  }
  return out;
}

function extensionOf(name) {
  return path.extname(String(name)).toLowerCase();
}

function stripPath(p) {
  return String(p).split(/[\\/]/).pop();
}

/**
 * Parse `7z l -slt` output into a flat list of files.
 *
 * Records are normally delimited by a `----------` line, but that separator
 * disappears under some 7-Zip build/flag combinations, so a fresh `Path =`
 * also starts a new record.
 */
function parseListing(stdout) {
  const entries = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path && !cur.folder) entries.push(cur);
    cur = null;
  };
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "----------") {
      flush();
      continue;
    }
    const eq = line.indexOf(" = ");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 3).trim();
    if (key === "Path" && cur && cur.path) flush();
    if (!cur) cur = { path: "", size: 0, folder: false };
    if (key === "Path") cur.path = value;
    else if (key === "Size") cur.size = Number(value) || 0;
    else if (key === "Folder") cur.folder = value === "+";
  }
  flush();
  return entries;
}

// -------------------------------------------------------------- archive work

async function downloadRelease(releaseId) {
  const url = `${SOURCE}/base.php?srt=${encodeURIComponent(releaseId)}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fansubs.ru returned HTTP ${res.status} for release ${releaseId}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 32) throw new Error(`Release ${releaseId} returned an empty archive`);

  const disposition = res.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  let name = match ? decodeURIComponent(match[1].trim()) : `release_${releaseId}.rar`;
  name = stripPath(name).replace(/[^\w.\- ]+/g, "_");
  if (!extensionOf(name)) name += ".rar";
  return { buffer, name };
}

async function listArchive(archivePath) {
  const { stdout } = await execFileAsync(SEVENZIP, ["l", "-slt", archivePath], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseListing(stdout);
}

/**
 * Choose the subtitle entry for an episode.
 *
 * Matching runs on the base name only. Release archives are often organised
 * into a folder per series — e.g. "Attak on Titan 01-07/[gg]_..._-_02_....ass"
 * — and the folder's own range would otherwise add 1 and 7 to *every* file's
 * candidate set, making the requested episode ambiguous.
 *
 * 1. exact episode-number match in the file name
 * 2. a lone subtitle file (covers movie / OVA style single-file releases)
 */
function pickEntry(entries, episode) {
  const subs = entries.filter((e) => SUBTITLE_EXT.has(extensionOf(e.path)));
  if (!subs.length) {
    throw new Error("The release archive contains no .ass/.ssa/.srt/.vtt files");
  }
  if (episode != null) {
    const exact = subs.filter((e) => episodeCandidates(stripPath(e.path)).has(episode));
    if (exact.length) {
      // Prefer the shortest name — avoids "[Group] Show 01 (720p) [hash].ass"
      // style duplicates and picks the most specific match.
      exact.sort(
        (a, b) => stripPath(a.path).length - stripPath(b.path).length || a.size - b.size
      );
      return exact[0];
    }
  }
  if (subs.length === 1) return subs[0];
  throw new Error(
    `Episode ${episode} is not present in this release (found ${subs.length} subtitle files, e.g. ` +
      subs
        .slice(0, 3)
        .map((e) => stripPath(e.path))
        .join(", ") +
      `). Try a different release.`
  );
}

async function extractEntry(archivePath, entryPath, outDir) {
  await execFileAsync(SEVENZIP, ["e", archivePath, `-o${outDir}`, "-y", entryPath], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const direct = path.join(outDir, path.basename(entryPath));
  if (fs.existsSync(direct)) return direct;
  // Fall back to whatever landed in the output directory.
  const files = await fsp.readdir(outDir);
  if (files.length === 1) return path.join(outDir, files[0]);
  throw new Error("Extraction produced no output file");
}

/** Sniff the encoding so players render Cyrillic correctly. */
function detectCharset(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { charset: "utf-8", body: buf.subarray(3) };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { charset: "utf-16le", body: buf.subarray(2) };
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { charset: "utf-8", body: buf };
  } catch (_) {
    return { charset: "windows-1251", body: buf };
  }
}

// -------------------------------------------------------------------- route

async function resolveSubtitle({ srt, ep }) {
  const key = `${srt}:${ep}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (hit) cache.delete(key);

  const work = await (async () => {
    const { buffer, name } = await downloadRelease(srt);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fansubs-"));
    const archivePath = path.join(dir, name);
    try {
      await fsp.writeFile(archivePath, buffer);
      const entries = await listArchive(archivePath);
      const entry = pickEntry(entries, ep);
      const outPath = await extractEntry(archivePath, entry.path, dir);
      const raw = await fsp.readFile(outPath);
      const { charset, body } = detectCharset(raw);
      const ext = extensionOf(entry.path) || ".ass";
      const fileName = `episode-${String(ep == null ? 1 : ep).padStart(2, "0")}${ext}`;
      return {
        body,
        name: fileName,
        type: `${contentTypeFor(ext)}; charset=${charset}`,
        source: stripPath(entry.path),
        archive: name,
      };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  cache.set(key, { ...work, expires: Date.now() + CACHE_TTL_MS });
  return work;
}

function contentTypeFor(ext) {
  switch (ext) {
    case ".ass":
    case ".ssa":
      return "text/x-ssa";
    case ".vtt":
      return "text/vtt";
    default:
      return "text/plain";
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Source-Entry, X-Source-Archive",
    "Cache-Control": "public, max-age=600",
    ...headers,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/health") {
    try {
      await sevenZip();
      return send(res, 200, JSON.stringify({ ok: true, source: SOURCE, sevenZip: SEVENZIP }));
    } catch (err) {
      return send(res, 503, JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (url.pathname !== "/subtitle") {
    return send(res, 404, JSON.stringify({ error: "Not found. Use /subtitle?srt=<id>&ep=<n>" }));
  }

  const srt = url.searchParams.get("srt");
  const epRaw = url.searchParams.get("ep");

  if (!srt || !/^\d+$/.test(srt)) {
    return send(res, 400, JSON.stringify({ error: "Missing or invalid 'srt' release id" }));
  }
  let ep = null;
  if (epRaw != null && epRaw !== "") {
    if (!/^\d+$/.test(epRaw)) {
      return send(res, 400, JSON.stringify({ error: "Invalid 'ep' episode number" }));
    }
    ep = Number(epRaw);
    if (ep < 1 || ep > MAX_EPISODE) {
      return send(res, 400, JSON.stringify({ error: "'ep' out of range" }));
    }
  }

  try {
    const result = await resolveSubtitle({ srt, ep });
    return send(res, 200, result.body, {
      "Content-Type": result.type,
      "Content-Disposition": `inline; filename="${result.name}"`,
      "X-Source-Entry": encodeURIComponent(result.source),
      "X-Source-Archive": encodeURIComponent(result.archive),
    });
  } catch (err) {
    return send(res, 502, JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`fansubs.ru resolver listening on http://${HOST}:${PORT}`);
  console.log(`  source   : ${SOURCE}`);
  console.log(`  7-Zip    : ${SEVENZIP}`);
  console.log(`  example  : http://${HOST}:${PORT}/subtitle?srt=13364&ep=1`);
});

