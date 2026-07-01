/** Live end-to-end check of the authenticated CRUD path (Node).
 *
 *  Run:  npm run build && npm run verify:crud
 *
 *  Uses the loopback OAuth (reusing the bundled client the gsab Python CLI installed), so the
 *  first run opens a browser once; after that the cached refresh token is reused. It creates a
 *  throwaway spreadsheet, exercises every write op, and prints its URL at the end for you to
 *  inspect or delete. Requires the gsab Python CLI to have been set up once (`gsab auth login`),
 *  or pass a clientSecretPath to loopbackAuth().
 */
import { connect } from "gsab";
import { loopbackAuth } from "gsab/node";

const schema = {
  name: "users",
  fields: {
    id: { type: "integer", primaryKey: true },
    name: { type: "string", required: true, maxLength: 40 },
    plan: { type: "string", default: "free" },
    price: { type: "float" },
  },
};

const log = (label, value) => console.log(`  ${label.padEnd(22)}`, value);

async function main() {
  console.log("→ signing in (browser opens on first run; token cached after)…");
  const auth = await loopbackAuth();
  const db = connect({ auth }).sheet(schema);

  const id = await db.createSheet(`gsab-js verify ${new Date().toISOString()}`);
  log("createSheet →", id);

  await db.insert({ id: 1, name: "Ada", plan: "pro", price: 9.5 });
  const n = await db.bulkInsert([
    { id: 2, name: "Linus" },
    { id: 3, name: "Grace", plan: "team", price: 20 },
  ]);
  log("insert + bulkInsert →", `${1 + n} rows`);

  log("read (all) →", JSON.stringify(await db.read()));
  log("read {plan: pro} →", JSON.stringify(await db.read({ plan: "pro" })));
  log("query gviz →", JSON.stringify(await db.query("SELECT A, B WHERE D > 5 ORDER BY D DESC")));

  log("update →", `${await db.update({ id: 1 }, { plan: "team" })} changed`);
  log("upsert (existing) →", await db.upsert({ id: 2, price: 5 }));
  log("upsert (new) →", await db.upsert({ id: 9, name: "New" }));
  log("delete {id: 3} →", `${await db.delete({ id: 3 })} deleted`);

  const url = await db.share("reader");
  log("share →", url);
  log("csvUrl →", db.csvUrl);
  log("final rows →", JSON.stringify(await db.read()));

  console.log(`\n✓ authenticated CRUD verified. Inspect or delete the sheet:\n  ${url}`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.constructor.name}: ${e.message}`);
  process.exit(1);
});
