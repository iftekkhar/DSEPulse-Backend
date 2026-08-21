import { initDB } from '../server/db.js';
import { runAuditedEPSWeeklyScraper } from '../server/scrapers/audited_eps_scraper.js';

async function main() {
  console.log('Initializing SQLite Database connection...');
  await initDB();
  
  const result = await runAuditedEPSWeeklyScraper(4);
  console.log('Execution Summary:', JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error running Audited EPS Scraper:', err);
  process.exit(1);
});
