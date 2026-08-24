/**
 * Branded Open Graph share images for Deep Dive pages -- when a
 * /deep-dive/:symbol link is shared (WhatsApp, Twitter, Slack, Facebook),
 * the platform fetches this to render the branded preview card. Built with
 * a hand-written SVG template rasterized via sharp (no headless browser --
 * this card is simple enough that a full Chromium/Playwright dependency
 * would be a lot of weight for very little benefit).
 *
 * This is the actual, buildable version of "shared links carry our
 * branding" from the plan -- distinct from (and not a substitute for)
 * screenshot/download prevention, which isn't achievable on the web at all
 * (see ARCHITECTURE.md/the plan's Security section).
 */
import sharp from 'sharp';
import { dbGet } from './db.js';

const WIDTH = 1200;
const HEIGHT = 630;

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetches just what the card needs (symbol, company name, sector, latest
 * close + change) -- a lightweight targeted query rather than the full
 * getAllStocksFromDB() pipeline, since this endpoint only ever needs one row.
 */
async function fetchCardData(symbol) {
  const cleanSym = String(symbol || '').toUpperCase().trim();
  const row = await dbGet(`
    SELECT
      c.symbol, c.name, c.sector,
      p.close, p.ycp, p.date
    FROM company_list c
    LEFT JOIN (
      SELECT ph1.symbol, ph1.close, ph1.ycp, ph1.date
      FROM price_history ph1
      INNER JOIN (SELECT symbol, MAX(date) AS max_date FROM price_history WHERE symbol = ? GROUP BY symbol) ph2
        ON ph1.symbol = ph2.symbol AND ph1.date = ph2.max_date
    ) p ON p.symbol = c.symbol
    WHERE c.symbol = ?
  `, [cleanSym, cleanSym]);

  if (!row) return { symbol: cleanSym, name: null, sector: null, close: null, changePercent: null };

  const close = row.close !== null && row.close !== undefined ? Number(row.close) : null;
  const ycp = row.ycp !== null && row.ycp !== undefined ? Number(row.ycp) : null;
  const changePercent = (close !== null && ycp !== null && ycp > 0)
    ? Number((((close - ycp) / ycp) * 100).toFixed(2))
    : null;

  return { symbol: cleanSym, name: row.name, sector: row.sector, close, changePercent };
}

function buildSvg({ symbol, name, sector, close, changePercent }) {
  const isUp = changePercent !== null && changePercent >= 0;
  const changeColor = changePercent === null ? '#94a3b8' : (isUp ? '#34d399' : '#fb7185');
  const priceText = close !== null ? `৳${close.toFixed(2)}` : 'Price unavailable';
  const changeText = changePercent !== null ? `${isUp ? '+' : ''}${changePercent.toFixed(2)}%` : '';

  return `
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1329"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <circle cx="1080" cy="80" r="220" fill="#2563eb" opacity="0.08"/>
  <circle cx="120" cy="560" r="180" fill="#f59e0b" opacity="0.06"/>

  <!-- Brand -->
  <rect x="80" y="70" width="44" height="44" rx="12" fill="#2563eb"/>
  <text x="102" y="99" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="#ffffff" text-anchor="middle">D</text>
  <text x="140" y="102" font-family="Arial, sans-serif" font-size="26" font-weight="900" fill="#ffffff">DSE Pulse</text>

  <!-- Symbol -->
  <text x="80" y="240" font-family="Arial, sans-serif" font-size="72" font-weight="900" fill="#ffffff">${escapeXml(symbol)}</text>
  <text x="80" y="280" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="#94a3b8">${escapeXml(name || '')}${sector ? ' • ' + escapeXml(sector) : ''}</text>

  <!-- Price -->
  <text x="80" y="380" font-family="Arial, sans-serif" font-size="64" font-weight="900" fill="#ffffff">${escapeXml(priceText)}</text>
  ${changeText ? `<text x="80" y="425" font-family="Arial, sans-serif" font-size="30" font-weight="800" fill="${changeColor}">${escapeXml(changeText)}</text>` : ''}

  <!-- Footer -->
  <text x="80" y="560" font-family="Arial, sans-serif" font-size="18" font-weight="600" fill="#64748b">Full 13-year audited history &amp; Deep Dive analysis</text>
  <text x="80" y="590" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#475569">dsepulse.com/deep-dive/${escapeXml(symbol)}</text>
</svg>`;
}

/** Returns a PNG Buffer for the given symbol's branded share card. */
export async function generateDeepDiveOgImage(symbol) {
  const cardData = await fetchCardData(symbol);
  const svg = buildSvg(cardData);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
