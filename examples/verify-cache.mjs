/** Live check of the reactive cache over a PUBLIC sheet (no auth).
 *
 *  Run:  npm run build && npm run verify:cache
 *
 *  Loads an initial snapshot (the "ready" event), prints it, and wires the granular
 *  insert/update/delete listeners. The sample sheet is static, so no deltas fire — edit a
 *  copy of your own and watch them stream in. */
import { connect, createCache } from "gsab-js";

// Google's public "Class Data" sample sheet.
const URL =
  "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";

const db = connect(URL).sheet();
const cache = createCache(db, { interval: 3000 });

cache.on("ready", (rows) => console.log(`  ready         → ${rows.length} rows cached`));
cache.on("insert", (r) => console.log("  insert        →", r));
cache.on("update", (r, prev) => console.log("  update        →", prev, "→", r));
cache.on("delete", (r) => console.log("  delete        →", r));
cache.on("error", (e) => console.error("  error         →", e));

await cache.start();
console.log("  first row     →", cache.all()[0]);
console.log("  size          →", cache.size);
cache.stop();
console.log("\n✓ reactive cache verified (initial snapshot loaded live over a public sheet).");
