import { dbAll, dbGet } from '../server/db.js';

async function inspect() {
  const tables = await dbAll("SELECT name, sql FROM sqlite_master WHERE type='table'");
  console.log('Tables in dse.db:');
  for (const t of tables) {
    if (t.name.startsWith('sqlite_')) continue;
    const c = await dbGet('SELECT COUNT(*) as cnt FROM ' + t.name);
    console.log(`- ${t.name}: ${c.cnt} rows`);
  }
  process.exit(0);
}

inspect().catch(console.error);
