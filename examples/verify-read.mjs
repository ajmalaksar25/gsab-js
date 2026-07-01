// Verify the no-auth read/query/watch tier against Google's public "Class Data" sample.
// Run: npm run build && npm run verify:read
import { connect } from "../dist/index.js";

const PUBLIC_SAMPLE = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const db = connect(PUBLIC_SAMPLE).sheet(); // schemaless, public, no auth

console.log("— read() all rows —");
const rows = await db.read();
console.log("rows:", rows.length, "| first:", rows[0]);

console.log("\n— read() with filter { Gender: 'Male' } —");
const males = await db.read({ Gender: "Male" });
console.log("male rows:", males.length);

console.log("\n— query() server-side aggregate —");
const byState = await db.query("SELECT D, count(A) GROUP BY D ORDER BY count(A) DESC LIMIT 5");
console.log(byState);

console.log("\n— watch() initial snapshot —");
const ac = new AbortController();
for await (const change of db.watch({ interval: 1000, signal: ac.signal })) {
  console.log(`change: +${change.added.length} ~${change.updated.length} -${change.removed.length}`);
  ac.abort();
  break;
}
console.log("\nOK — read / query / watch verified against the public sheet.");
