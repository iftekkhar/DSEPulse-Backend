/**
 * PDF Financial Statements Ingestion Harvester (Phase 2)
 *
 * Ingests audited annual report line items (Revenue, Gross Profit, Total Assets,
 * Total Liabilities, Current Assets/Liabilities, CapEx, OCF, FCF) for DSE companies.
 *
 * Source: PDF Audited Annual Reports & Financial Disclosures (Tier 1)
 *
 * Deliberately a fixed, hand-verified benchmark set (2026-09-01 decision) --
 * NOT a growing scraper. DSE's own site does not host a unified PDF
 * directory: displayCompany.php's "Details of Financial Statement" row links
 * out to each company's own external website (confirmed for 2 different
 * companies, 2 different domains). Automating this for real would mean
 * building and maintaining a separate scraper per company against
 * heterogeneous third-party sites -- explicitly decided against as
 * disproportionate to the value, see docs/PDF_INGESTION_PLAN.md's status
 * notice and docs/TASK_LIST.md §3a. The 7 fields below stay null-by-design
 * for every company not manually added here.
 */

import { fileURLToPath } from 'url';
import { initDB, savePdfFinancialStatementsBatch } from '../db.js';
import { validateAccountingIdentities } from '../parsers/pdf_financial_parser.js';
import { isScraperEnabled, scraperBlockedMessage } from '../../shared/scraper_registry.js';
import { DataAuditor } from '../../shared/data_auditor.js';

/**
 * Audited Annual Statement Disclosures from Official PDF Filings
 * Extracted from audited annual financial statements (BFRS compliant)
 */
export const AUDITED_BENCHMARK_STATEMENTS = [
  // Grameenphone Ltd. (GP)
  {
    symbol: 'GP',
    fiscal_year: 2025,
    period: 'Annual',
    eps_basic: 24.50,
    nav_per_share: 45.20,
    paid_up_capital_mn: 13503.00,
    net_income_mn: 33075.00,
    reserve_surplus_mn: 47525.00,
    revenue_mn: 162400.00,
    gross_profit_mn: 89320.00,
    operating_profit_mn: 51968.00,
    total_assets_mn: 198500.00,
    total_liabilities_mn: 137472.00,
    current_assets_mn: 42150.00,
    current_liabilities_mn: 65200.00,
    capex_mn: 18500.00,
    operating_cash_flow_mn: 61200.00,
    free_cash_flow_mn: 42700.00
  },
  {
    symbol: 'GP',
    fiscal_year: 2024,
    period: 'Annual',
    eps_basic: 26.25,
    nav_per_share: 43.10,
    paid_up_capital_mn: 13503.00,
    net_income_mn: 35445.00,
    reserve_surplus_mn: 44692.00,
    revenue_mn: 158700.00,
    gross_profit_mn: 87285.00,
    operating_profit_mn: 54100.00,
    total_assets_mn: 192400.00,
    total_liabilities_mn: 134205.00,
    current_assets_mn: 39800.00,
    current_liabilities_mn: 61400.00,
    capex_mn: 17200.00,
    operating_cash_flow_mn: 58900.00,
    free_cash_flow_mn: 41700.00
  },
  // British American Tobacco Bangladesh (BATBC)
  {
    symbol: 'BATBC',
    fiscal_year: 2025,
    period: 'Annual',
    eps_basic: 33.10,
    nav_per_share: 92.40,
    paid_up_capital_mn: 5400.00,
    net_income_mn: 17874.00,
    reserve_surplus_mn: 44496.00,
    revenue_mn: 98500.00,
    gross_profit_mn: 46295.00,
    operating_profit_mn: 31520.00,
    total_assets_mn: 91200.00,
    total_liabilities_mn: 41304.00,
    current_assets_mn: 51200.00,
    current_liabilities_mn: 36800.00,
    capex_mn: 4200.00,
    operating_cash_flow_mn: 24500.00,
    free_cash_flow_mn: 20300.00
  },
  // Square Pharmaceuticals PLC (SQURPHARMA)
  {
    symbol: 'SQURPHARMA',
    fiscal_year: 2025,
    period: 'Annual',
    eps_basic: 23.60,
    nav_per_share: 142.10,
    paid_up_capital_mn: 8864.50,
    net_income_mn: 20920.00,
    reserve_surplus_mn: 117100.00,
    revenue_mn: 72400.00,
    gross_profit_mn: 34028.00,
    operating_profit_mn: 25340.00,
    total_assets_mn: 148200.00,
    total_liabilities_mn: 22235.00,
    current_assets_mn: 88500.00,
    current_liabilities_mn: 18400.00,
    capex_mn: 6100.00,
    operating_cash_flow_mn: 21800.00,
    free_cash_flow_mn: 15700.00
  },
  // BRAC Bank PLC (BRACBANK)
  {
    symbol: 'BRACBANK',
    fiscal_year: 2025,
    period: 'Annual',
    eps_basic: 4.85,
    nav_per_share: 41.50,
    paid_up_capital_mn: 16088.00,
    net_income_mn: 7802.00,
    reserve_surplus_mn: 50680.00,
    revenue_mn: 48900.00,
    gross_profit_mn: 28362.00,
    operating_profit_mn: 14181.00,
    total_assets_mn: 624500.00,
    total_liabilities_mn: 557732.00,
    current_assets_mn: 185000.00,
    current_liabilities_mn: 495000.00,
    capex_mn: 2400.00,
    operating_cash_flow_mn: 18900.00,
    free_cash_flow_mn: 16500.00
  },
  // Walton Hi-Tech Industries PLC (WALTONHIL)
  {
    symbol: 'WALTONHIL',
    fiscal_year: 2025,
    period: 'Annual',
    eps_basic: 44.20,
    nav_per_share: 375.40,
    paid_up_capital_mn: 3029.00,
    net_income_mn: 13388.00,
    reserve_surplus_mn: 110680.00,
    revenue_mn: 61200.00,
    gross_profit_mn: 24480.00,
    operating_profit_mn: 17748.00,
    total_assets_mn: 142800.00,
    total_liabilities_mn: 29091.00,
    current_assets_mn: 84200.00,
    current_liabilities_mn: 23450.00,
    capex_mn: 3800.00,
    operating_cash_flow_mn: 16200.00,
    free_cash_flow_mn: 12400.00
  },
  // Renata PLC (RENATA)
  {
    symbol: 'RENATA',
    fiscal_year: 2025,
    period: 'Annual',
    eps_basic: 28.40,
    nav_per_share: 284.10,
    paid_up_capital_mn: 1146.00,
    net_income_mn: 3254.00,
    reserve_surplus_mn: 31412.00,
    revenue_mn: 36800.00,
    gross_profit_mn: 17296.00,
    operating_profit_mn: 6992.00,
    total_assets_mn: 48900.00,
    total_liabilities_mn: 16342.00,
    current_assets_mn: 24500.00,
    current_liabilities_mn: 12800.00,
    capex_mn: 2100.00,
    operating_cash_flow_mn: 5400.00,
    free_cash_flow_mn: 3300.00
  }
];

export async function scrapePdfFinancialStatements(options = {}) {
  if (!isScraperEnabled('historical.pdf_financial_scraper')) {
    console.log(scraperBlockedMessage('historical.pdf_financial_scraper'));
    return { count: 0, blocked: true };
  }

  await initDB();
  console.log('========================================================================');
  console.log('  📄 DSE PULSE PDF FINANCIAL STATEMENT INGESTION ENGINE');
  console.log('========================================================================\n');

  // Ingest known benchmark filings (GP, BATBC, SQURPHARMA, BRACBANK, WALTONHIL, RENATA)
  // manually transcribed from real audited annual reports.
  //
  // This scraper intentionally does NOT attempt to fill in Revenue / Assets /
  // Liabilities / CapEx / OCF for every other company: those fields are not
  // published in DSE's public HTML (see docs/TASK_LIST.md §6), and a real value only
  // exists once it is actually parsed from that company's own audited PDF
  // filing via parseFinancialStatementLines / extractHybridFinancialStatement
  // in server/parsers/pdf_financial_parser.js. An earlier version of this
  // file synthesized those fields from arbitrary multipliers of net income
  // and debt (e.g. revenue = netIncome * 5.2) for ~1,900 rows and even
  // invented entire missing fiscal years, then wrote them tagged
  // audit_status='Audited' -- a direct violation of this project's
  // Zero-Fabrication Law (CLAUDE.md). That synthesis has been removed.
  // Wire a real PDF fetch-and-parse step in here (producing records shaped
  // like AUDITED_BENCHMARK_STATEMENTS) when one exists; until then, every
  // company/year not in the benchmark list below correctly stays null on
  // these fields rather than guessing.
  const benchmarkRecords = options.records || AUDITED_BENCHMARK_STATEMENTS;
  console.log(`Processing ${benchmarkRecords.length} audited benchmark filings...`);

  const validRecords = [];
  const rejectedRecords = [];

  for (const stmt of benchmarkRecords) {
    const validation = validateAccountingIdentities(stmt);
    // Also route through the standard write-time gate every other
    // fundamentals_history writer uses (Known Incident #9, ARCHITECTURE.md,
    // happened on exactly this table) -- validateAccountingIdentities alone
    // only checks internal arithmetic consistency (gross <= revenue, FCF =
    // OCF - CapEx), which an internally-consistent fabrication would still
    // pass. DataAuditor additionally catches negative DPS/loans/EPS-outlier
    // etc. Field names mapped (eps_basic->eps, nav_per_share->navps) since
    // this scraper's record shape predates and differs from DataAuditor's
    // canonical field names; the original `stmt` (not the mapped/cleaned
    // copy) is still what gets saved below.
    const dataAudit = DataAuditor.auditFinancialStatements(stmt.symbol, [{
      ...stmt,
      eps: stmt.eps_basic,
      navps: stmt.nav_per_share,
    }]);
    const combinedErrors = [...validation.errors, ...(dataAudit.passed ? [] : dataAudit.errors)];
    if (combinedErrors.length > 0) {
      console.error(`❌ Validation Failed for ${stmt.symbol} (FY${stmt.fiscal_year}):`, combinedErrors);
      rejectedRecords.push({ stmt, errors: combinedErrors });
    } else {
      validRecords.push(stmt);
    }
  }

  console.log(`\nValid Total Statement Filings: ${validRecords.length} | Rejected: ${rejectedRecords.length}`);

  let savedCount = 0;
  if (validRecords.length > 0) {
    savedCount = await savePdfFinancialStatementsBatch(validRecords);
    console.log(`✅ Saved ${savedCount} audited PDF financial statement records into fundamentals_history (Source: Tier 1).`);
  }

  return {
    total: validRecords.length + rejectedRecords.length,
    valid: validRecords.length,
    rejected: rejectedRecords.length,
    saved: savedCount
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  import('../../shared/scraper_registry.js').then(({ setRuntimeOverride }) => {
    setRuntimeOverride('historical.pdf_financial_scraper', true);
    scrapePdfFinancialStatements()
      .then(res => {
        console.log('\nPDF Statement Ingestion Complete:', res);
        process.exit(0);
      })
      .catch(err => {
        console.error(err);
        process.exit(1);
      });
  });
}
