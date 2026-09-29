/**
 * Local harness that exercises script.js the way Hayase would.
 *
 *   node test-extension.mjs
 *
 * Hayase runs extensions in a sandboxed worker and hands the handler a query
 * whose `fetch` is scope-bound to bypass CORS. The harness mirrors that
 * contract: it attaches a real fetch to each query rather than to the
 * instance, so a regression in how the extension obtains fetch is caught here.
 * `test()` gets no query, so it exercises the global-fetch fallback.
 */

import source from "./script.js";

const OPTS = {
  resolverBase: "http://127.0.0.1:8787",
  searchRetries: 3,
  useArchiveFallback: true,
  verifyAniDbId: true,
  preferredFormat: "any",
};

/**
 * The default export must be an instance, not the class — Hayase calls
 * methods straight off `module.default`. Assert that here so the harness
 * fails loudly if the export shape ever regresses.
 */
function makeSource() {
  if (source instanceof Function) {
    throw new Error(
      "default export is a class, not an instance — Hayase calls mod.test() directly and would silently fail"
    );
  }
  if (typeof source.test !== "function" || typeof source.single !== "function") {
    throw new Error("default export is missing test()/single()");
  }
  return source;
}

/** Attach the host-supplied scope-bound fetch, exactly as Hayase would. */
function asHayaseQuery(query) {
  return { ...query, fetch: (url, init) => fetch(url, init) };
}

const CASES = [
  {
    name: "Sousou no Frieren ep 5",
    query: {
      titles: ["Sousou no Frieren", "Frieren: Beyond Journey's End", "葬送のフリーレン"],
      episode: 5,
      anilistId: 154587,
      anidbAid: 17135,
      exclusions: [],
      resolution: "1080",
    },
  },
  {
    name: "Naruto ep 190 (SRT release, anidb verified)",
    query: {
      titles: ["Naruto", "Naruto Shippuuden"],
      episode: 190,
      anidbAid: 239,
      exclusions: [],
    },
  },
  {
    name: "Shingeki no Kyojin ep 1 (archive fallback path)",
    query: {
      titles: ["Shingeki no Kyojin", "Attack on Titan"],
      episode: 1,
      exclusions: ["x265"],
    },
  },
];

let failures = 0;

async function main() {
  const src = makeSource();

  console.log("--- test() ---");
  try {
    console.log("  health:", await src.test());
  } catch (err) {
    console.log("  health FAILED:", err.message);
    failures++;
  }

  for (const c of CASES) {
    console.log(`\n--- ${c.name} ---`);
    let results;
    try {
      results = await src.single(asHayaseQuery(c.query), OPTS);
    } catch (err) {
      console.log("  ERROR:", err.message);
      failures++;
      continue;
    }
    if (!results || !results.length) {
      console.log("  no results");
      continue;
    }
    for (const r of results.slice(0, 4)) {
      console.log(`  [${r.language}] ${r.url}`);
    }
    if (results.length > 4) console.log(`  ... and ${results.length - 4} more`);
  }

  console.log(`\n${failures ? failures + " FAILURE(S)" : "harness completed"}`);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
