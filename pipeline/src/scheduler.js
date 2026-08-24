import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeLiveMarketSnapshot } from './scrapers/live_scraper.js';
import { DataAuditor } from '../../shared/data_auditor.js';
import { publishLiveSnapshot } from './sync/publisher.js';
import { isScraperEnabled, scraperBlockedMessage, assertNoConflictingScrapers } from '../../shared/scraper_registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Refuses to boot if this process and the server would both be writing the
// same 15:30 BST closing snapshot -- see assertNoConflictingScrapers().
assertNoConflictingScrapers();

const DHAKA_TZ = 'Asia/Dhaka';

console.log('========================================================');
console.log('  DSEPULSE DATA PIPELINE & SCRAPER CRON ENGINE STARTED');
console.log(`  Timezone: ${DHAKA_TZ}`);
console.log('========================================================\n');

/**
 * 1. Live Market Ticker Job
 * Executes every 5 minutes during trading hours (10:00 - 14:30 BST, Sun-Thu)
 */
cron.schedule('*/5 10-14 * * 0-4', async () => {
  if (!isScraperEnabled('pipeline.live_ticker')) {
    console.log(scraperBlockedMessage('pipeline.live_ticker'));
    return;
  }
  console.log(`[PIPELINE] [${new Date().toLocaleTimeString('en-US', { timeZone: DHAKA_TZ })}] Running Live Market Scraper...`);
  try {
    const rawSnapshot = await scrapeLiveMarketSnapshot();
    if (rawSnapshot && rawSnapshot.stocks?.length > 0) {
      console.log(`[PIPELINE] Scraped ${rawSnapshot.stocks.length} stocks. Running audit...`);
      const auditResult = DataAuditor.auditPriceHistory('LIVE_MARKET', rawSnapshot.stocks);
      if (auditResult.passed || auditResult.cleaned.length > 0) {
        await publishLiveSnapshot({
          ...rawSnapshot,
          stocks: auditResult.cleaned
        });
        console.log(`[PIPELINE] Successfully audited & published ${auditResult.cleaned.length} live stocks to backend.`);
      }
    }
  } catch (err) {
    console.error(`[PIPELINE ERROR] Live market scraper job failed: ${err.message}`);
  }
}, { timezone: DHAKA_TZ });

/**
 * 2. Official Daily Closing Prices Settlement Job
 * Executes at 15:30 BST (Sun-Thu)
 */
cron.schedule('30 15 * * 0-4', async () => {
  if (!isScraperEnabled('pipeline.eod_settlement')) {
    console.log(scraperBlockedMessage('pipeline.eod_settlement'));
    return;
  }
  console.log(`[PIPELINE] [${new Date().toLocaleTimeString('en-US', { timeZone: DHAKA_TZ })}] Running EOD Closing Settlement...`);
  try {
    const snapshot = await scrapeLiveMarketSnapshot();
    if (snapshot && snapshot.stocks?.length > 0) {
      const auditResult = DataAuditor.auditPriceHistory('EOD_CLOSING', snapshot.stocks);
      // Was publishing `cleaned` unconditionally, even when the audit found
      // blocking errors -- gate on `passed` the same way the live-ticker job
      // above already does, so a failed audit actually blocks the write.
      if (auditResult.passed && auditResult.cleaned.length > 0) {
        await publishLiveSnapshot({
          ...snapshot,
          stocks: auditResult.cleaned
        });
        console.log(`[PIPELINE] EOD Closing settlement published successfully (${auditResult.cleaned.length} stocks).`);
      } else {
        console.error(`[PIPELINE] EOD Closing settlement BLOCKED by audit:`, auditResult.errors);
      }
    }
  } catch (err) {
    console.error(`[PIPELINE ERROR] EOD Settlement failed: ${err.message}`);
  }
}, { timezone: DHAKA_TZ });
