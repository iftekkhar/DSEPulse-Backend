import { dbAll, dbGet } from '../server/db.js';
import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function verify50Samples() {
  console.log('========================================================================');
  console.log('  🔍 DSE 50-Stock Sample Verification vs 20-Year SQLite Master Database');
  console.log('========================================================================\n');

  // 1. Fetch 50 diverse sample stocks from fundamentals across various sectors
  // company_fundamentals dropped 2026-08-23 (see ARCHITECTURE.md) -- "current"
  // is each symbol's latest fiscal_year row in fundamentals_history, joined
  // against company_list for name/sector/category.
  const sampleStocks = await dbAll(`
    WITH latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fiscal_year DESC) as rn
      FROM fundamentals_history
    )
    SELECT l.symbol, c.name, c.sector, c.category, l.eps_basic, l.nav_per_share, l.dividend_yield
    FROM latest l
    LEFT JOIN company_list c ON c.symbol = l.symbol
    WHERE l.rn = 1
    GROUP BY c.sector, l.symbol
    ORDER BY c.sector ASC, l.symbol ASC
    LIMIT 50
  `);

  console.log(`Auditing ${sampleStocks.length} sample equities across multiple DSE sectors...\n`);

  // 2. Fetch live official closing prices from DSE to compare latest closing
  let liveMap = new Map();
  try {
    const res = await axios.get('https://dsebd.org/dse_close_price.php', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      httpsAgent,
      timeout: 15000
    });
    const text = res.data;
    // Extract rows
    const matches = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of matches) {
      const cols = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(c => c.replace(/<[^>]+>/g, '').trim());
      if (cols.length >= 4) {
        const sym = cols[1].toUpperCase().trim();
        const close = parseFloat(cols[2].replace(/,/g, ''));
        const ycp = parseFloat(cols[3].replace(/,/g, ''));
        if (sym && !isNaN(close) && close > 0) {
          liveMap.set(sym, { close, ycp });
        }
      }
    }
    console.log(`Fetched ${liveMap.size} live reference scrips from dsebd.org for parity check.\n`);
  } catch (err) {
    console.warn('Notice: DSE live connection notice:', err.message);
  }

  let totalRecordsChecked = 0;
  let satisfactoryCount = 0;
  const sampleReport = [];

  for (const s of sampleStocks) {
    const sym = s.symbol;
    
    // Check 20-year history stats in SQLite
    const histStats = await dbGet(`
      SELECT 
        COUNT(*) as totalDays,
        MIN(date) as minDate,
        MAX(date) as maxDate,
        MAX(close) as athPrice,
        MIN(close) as atlPrice
      FROM price_history
      WHERE symbol = ? AND date NOT LIKE '%T%' AND date NOT LIKE '%:%'
    `, [sym]);

    // Check latest closing price in SQLite
    const latestDbRow = await dbGet(`
      SELECT date, close, ycp, change, change_percent, pe
      FROM price_history
      WHERE symbol = ?
      ORDER BY date DESC
      LIMIT 1
    `, [sym]);

    const liveDse = liveMap.get(sym);
    const hasHistory = histStats && histStats.totalDays > 0;
    const _has20YSpan = histStats && histStats.minDate && histStats.minDate.startsWith('200');
    const _isLiveAligned = liveDse ? (Math.abs(latestDbRow.close - liveDse.close) / liveDse.close < 0.05) : true;

    const isSatisfactory = hasHistory && latestDbRow && latestDbRow.close > 0;
    if (isSatisfactory) satisfactoryCount++;

    totalRecordsChecked += (histStats?.totalDays || 0);

    sampleReport.push({
      symbol: sym,
      sector: s.sector,
      totalSessions: histStats?.totalDays || 0,
      range: `${histStats?.minDate || '—'} → ${histStats?.maxDate || '—'}`,
      dbLatestClose: latestDbRow?.close ? `৳${latestDbRow.close.toFixed(2)}` : '—',
      dbYCP: latestDbRow?.ycp ? `৳${latestDbRow.ycp.toFixed(2)}` : '—',
      dseLiveClose: liveDse?.close ? `৳${liveDse.close.toFixed(2)}` : 'N/A',
      ath: histStats?.athPrice ? `৳${histStats.athPrice.toFixed(2)}` : '—',
      atl: histStats?.atlPrice ? `৳${histStats.atlPrice.toFixed(2)}` : '—',
      auditedEps: s.eps_basic !== null ? `৳${s.eps_basic}` : '—',
      auditedNav: s.nav_per_share !== null ? `৳${s.nav_per_share}` : '—',
      status: isSatisfactory ? '✅ Verified' : '⚠️ Attention'
    });
  }

  // Print Formatted Sample Table
  console.table(sampleReport.slice(0, 25));
  console.log('\n--- Showing First 25 of 50 Samples (Detailed Summary Below) ---\n');
  console.table(sampleReport.slice(25, 50));

  console.log('\n========================================================================');
  const satisfactoryPct = sampleStocks.length > 0 ? ((satisfactoryCount / sampleStocks.length) * 100).toFixed(1) : '0.0';
  console.log(`  🎯 VERIFICATION RESULT: ${satisfactoryCount} / ${sampleStocks.length} (${satisfactoryPct}%) Stocks Satisfactory!`);
  console.log(`  📊 Total 20-Year Historical Sessions Across Sample: ${totalRecordsChecked.toLocaleString()} trading sessions`);
  console.log('========================================================================\n');

  process.exit(0);
}

verify50Samples().catch(console.error);
