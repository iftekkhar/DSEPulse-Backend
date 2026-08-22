export function getApiExplorerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSE Pulse Backend — JSON API Explorer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --primary: #38bdf8;
      --primary-hover: #0284c7;
      --accent: #10b981;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --table-header: #0f172a;
      --row-hover: #334155/50;
      --row-alt: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: rgba(15, 23, 42, 0.9);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      padding: 1rem 1.5rem;
      position: sticky;
      top: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-badge {
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: white;
      font-weight: 800;
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      letter-spacing: 0.05em;
    }
    .brand h1 {
      font-size: 1.15rem;
      font-weight: 700;
      color: white;
      letter-spacing: -0.02em;
    }
    .status-strip {
      display: flex;
      align-items: center;
      gap: 1.25rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background-color: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
      display: inline-block;
      margin-right: 0.35rem;
    }
    .container {
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
      padding: 1.5rem;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    
    /* Tabs Navigation */
    .tabs-nav {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      overflow-x: auto;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--card-border);
      scrollbar-width: thin;
    }
    .tab-btn {
      background: var(--card-bg);
      color: var(--text-muted);
      border: 1px solid var(--card-border);
      padding: 0.6rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .tab-btn:hover {
      background: #334155;
      color: white;
    }
    .tab-btn.active {
      background: #0284c7;
      color: white;
      border-color: #38bdf8;
      box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);
    }
    .tab-btn .method {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      font-weight: 700;
      background: rgba(0,0,0,0.3);
      padding: 0.15rem 0.35rem;
      border-radius: 0.25rem;
      color: #38bdf8;
    }
    .tab-btn.active .method {
      color: white;
      background: rgba(0,0,0,0.2);
    }

    /* Controls Bar */
    .controls-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.75rem;
      padding: 1rem 1.25rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .endpoint-display {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.9rem;
    }
    .method-tag {
      background: #0284c7;
      color: white;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      font-weight: 700;
      font-size: 0.75rem;
    }
    .url-text {
      color: #38bdf8;
      font-weight: 500;
    }
    .actions-group {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .param-input {
      background: #0f172a;
      border: 1px solid var(--card-border);
      color: white;
      padding: 0.45rem 0.75rem;
      border-radius: 0.375rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      width: 140px;
      outline: none;
    }
    .param-input:focus {
      border-color: #38bdf8;
    }
    .chip {
      background: #0f172a;
      border: 1px solid var(--card-border);
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: all 0.1s;
    }
    .chip:hover {
      border-color: #38bdf8;
      color: white;
    }
    .btn-exec {
      background: #10b981;
      color: #0f172a;
      font-weight: 700;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      font-size: 0.85rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: background 0.15s;
    }
    .btn-exec:hover {
      background: #34d399;
    }
    .btn-toggle {
      background: #334155;
      color: white;
      border: 1px solid var(--card-border);
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .btn-toggle:hover {
      background: #475569;
    }

    /* Stats & Search */
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .search-input {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: white;
      padding: 0.5rem 0.85rem;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      width: 260px;
      outline: none;
    }
    .search-input:focus {
      border-color: #38bdf8;
    }
    .meta-badges {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .badge {
      background: #1e293b;
      border: 1px solid var(--card-border);
      padding: 0.25rem 0.6rem;
      border-radius: 0.375rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
    }

    /* Table Surface */
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.75rem;
      overflow: auto;
      max-height: calc(100vh - 350px);
      min-height: 300px;
      position: relative;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.85rem;
      white-space: nowrap;
    }
    thead {
      background: #0f172a;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    th {
      padding: 0.75rem 1rem;
      font-weight: 700;
      color: #94a3b8;
      border-bottom: 1px solid var(--card-border);
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }
    td {
      padding: 0.65rem 1rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.4);
      color: #cbd5e1;
    }
    tbody tr:nth-child(even) {
      background: rgba(15, 23, 42, 0.25);
    }
    tbody tr:hover {
      background: rgba(56, 189, 248, 0.08);
    }
    .num {
      font-family: 'JetBrains Mono', monospace;
      text-align: right;
    }
    .pos { color: #34d399; font-weight: 600; }
    .neg { color: #f87171; font-weight: 600; }
    .sym-badge {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      color: #38bdf8;
    }
    .json-viewer {
      display: none;
      background: #0b1120;
      color: #a5f3fc;
      padding: 1.25rem;
      border-radius: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      overflow: auto;
      max-height: calc(100vh - 350px);
      white-space: pre;
    }
    .loading-spinner {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4rem;
      color: #38bdf8;
      font-weight: 600;
      gap: 0.75rem;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid rgba(56, 189, 248, 0.2);
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-badge">REST API ENGINE</span>
      <h1>DSE Pulse Institutional Backend</h1>
    </div>
    <div class="status-strip">
      <span><span class="status-dot"></span>Port 5001 Active</span>
      <span>SQLite: <code>data/dse.db</code></span>
      <span>Timezone: <code>Asia/Dhaka (UTC+6)</code></span>
    </div>
  </header>

  <div class="container">
    <!-- GET Endpoint Navigation Tabs -->
    <div class="tabs-nav" id="tabsNav">
      <button class="tab-btn active" data-endpoint="/api/stocks" data-type="array">
        <span class="method">GET</span> /api/stocks
      </button>
      <button class="tab-btn" data-endpoint="/api/market-breadth" data-type="object">
        <span class="method">GET</span> /api/market-breadth
      </button>
      <button class="tab-btn" data-endpoint="/api/history-analysis/:symbol" data-param="symbol" data-default="BRACBANK" data-type="analysis">
        <span class="method">GET</span> /api/history-analysis/:symbol
      </button>
      <button class="tab-btn" data-endpoint="/api/fundamentals" data-type="array">
        <span class="method">GET</span> /api/fundamentals
      </button>
      <button class="tab-btn" data-endpoint="/api/dsex-history" data-type="timeline">
        <span class="method">GET</span> /api/dsex-history
      </button>
      <button class="tab-btn" data-endpoint="/api/jobs/status" data-type="object">
        <span class="method">GET</span> /api/jobs/status
      </button>
      <button class="tab-btn" data-endpoint="/api/fundamentals-history/:symbol" data-param="symbol" data-default="SQURPHARMA" data-type="statements">
        <span class="method">GET</span> /api/fundamentals-history/:symbol
      </button>
    </div>

    <!-- Controls Bar -->
    <div class="controls-card">
      <div class="endpoint-display">
        <span class="method-tag">GET</span>
        <span class="url-text" id="currentUrlDisplay">/api/stocks</span>
      </div>

      <div class="actions-group">
        <div id="paramGroup" style="display: none; align-items: center; gap: 0.5rem;">
          <span style="font-size: 0.8rem; color: var(--text-muted);">Symbol:</span>
          <input type="text" id="symbolParam" class="param-input" value="BRACBANK">
          <div style="display: flex; gap: 0.25rem;">
            <span class="chip" onclick="setSymbol('BRACBANK')">BRACBANK</span>
            <span class="chip" onclick="setSymbol('SQURPHARMA')">SQURPHARMA</span>
            <span class="chip" onclick="setSymbol('GP')">GP</span>
            <span class="chip" onclick="setSymbol('BATBC')">BATBC</span>
          </div>
        </div>
        <button class="btn-exec" onclick="loadActiveEndpoint()">⚡ Execute Request</button>
        <button class="btn-toggle" id="viewToggleBtn" onclick="toggleView()">Switch to Raw JSON</button>
      </div>
    </div>

    <!-- Filter & Meta Bar -->
    <div class="filter-bar">
      <input type="text" id="tableSearch" class="search-input" placeholder="Filter rows in table..." oninput="filterTable()">
      <div class="meta-badges">
        <span class="badge" id="latencyBadge">⚡ 0ms</span>
        <span class="badge" id="rowsBadge">0 records</span>
        <span class="badge" style="color: #34d399;">HTTP 200 OK</span>
      </div>
    </div>

    <!-- Tabular Response Surface -->
    <div class="table-container" id="tableContainer">
      <div class="loading-spinner">
        <div class="spinner"></div>
        <span>Fetching live JSON payload...</span>
      </div>
      <table id="dataTable" style="display: none;">
        <thead id="tableHead"></thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>

    <!-- Raw JSON Surface -->
    <div class="json-viewer" id="jsonViewer"></div>
  </div>

  <script>
    let activeEndpoint = '/api/stocks';
    let activeType = 'array';
    let currentRawData = null;
    let isJsonView = false;

    function setSymbol(sym) {
      document.getElementById('symbolParam').value = sym;
      loadActiveEndpoint();
    }

    function toggleView() {
      isJsonView = !isJsonView;
      const tableCont = document.getElementById('tableContainer');
      const jsonView = document.getElementById('jsonViewer');
      const toggleBtn = document.getElementById('viewToggleBtn');

      if (isJsonView) {
        tableCont.style.display = 'none';
        jsonView.style.display = 'block';
        toggleBtn.innerText = 'Switch to Tabular View';
      } else {
        tableCont.style.display = 'block';
        jsonView.style.display = 'none';
        toggleBtn.innerText = 'Switch to Raw JSON';
      }
    }

    // Initialize tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        activeEndpoint = btn.getAttribute('data-endpoint');
        activeType = btn.getAttribute('data-type');
        const paramName = btn.getAttribute('data-param');
        const defaultParam = btn.getAttribute('data-default');

        const paramGroup = document.getElementById('paramGroup');
        if (paramName) {
          paramGroup.style.display = 'flex';
          if (defaultParam && !document.getElementById('symbolParam').value) {
            document.getElementById('symbolParam').value = defaultParam;
          }
        } else {
          paramGroup.style.display = 'none';
        }

        loadActiveEndpoint();
      });
    });

    async function loadActiveEndpoint() {
      let url = activeEndpoint;
      if (url.includes(':symbol')) {
        const sym = document.getElementById('symbolParam').value.trim().toUpperCase() || 'BRACBANK';
        url = url.replace(':symbol', encodeURIComponent(sym));
      }

      document.getElementById('currentUrlDisplay').innerText = url;
      const tableCont = document.getElementById('tableContainer');
      const dataTable = document.getElementById('dataTable');
      const jsonViewer = document.getElementById('jsonViewer');
      const rowsBadge = document.getElementById('rowsBadge');
      const latencyBadge = document.getElementById('latencyBadge');

      tableCont.querySelector('.loading-spinner')?.remove();
      const spinner = document.createElement('div');
      spinner.className = 'loading-spinner';
      spinner.innerHTML = '<div class="spinner"></div><span>Fetching live JSON from ' + url + '...</span>';
      tableCont.appendChild(spinner);
      dataTable.style.display = 'none';

      const t0 = performance.now();
      try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const latency = Math.round(performance.now() - t0);
        latencyBadge.innerText = '⚡ ' + latency + 'ms';

        const data = await res.json();
        currentRawData = data;
        jsonViewer.innerText = JSON.stringify(data, null, 2);
        spinner.remove();

        renderTable(data, activeType);
      } catch (err) {
        spinner.remove();
        tableCont.innerHTML = '<div style="padding: 2rem; color: #f87171;">Failed to load ' + url + ': ' + err.message + '</div>';
      }
    }

    function renderTable(data, type) {
      const dataTable = document.getElementById('dataTable');
      const head = document.getElementById('tableHead');
      const body = document.getElementById('tableBody');
      const rowsBadge = document.getElementById('rowsBadge');

      head.innerHTML = '';
      body.innerHTML = '';
      document.getElementById('tableSearch').value = '';

      let rows = [];

      if (Array.isArray(data)) {
        rows = data;
      } else if (type === 'analysis' && data) {
        // Quantitative breakdown
        const metrics = [
          { Key: 'Symbol', Value: data.symbol },
          { Key: 'Company Name', Value: data.fullName },
          { Key: 'Current Price', Value: '৳' + (data.currentPrice || '—') },
          { Key: 'All-Time High (ATH)', Value: '৳' + (data.ath?.price || '—') + ' (' + (data.ath?.date || '—') + ') [' + (data.ath?.drawdownPercent !== null && data.ath?.drawdownPercent !== undefined ? data.ath.drawdownPercent + '%' : '—') + ']' },
          { Key: 'All-Time Low (ATL)', Value: '৳' + (data.atl?.price || '—') + ' (' + (data.atl?.date || '—') + ') [+' + (data.atl?.risePercent !== null && data.atl?.risePercent !== undefined ? data.atl.risePercent + '%' : '—') + ']' },
          { Key: 'Max Drawdown', Value: (data.maxDrawdown?.percent !== null && data.maxDrawdown?.percent !== undefined ? data.maxDrawdown.percent + '%' : '—') + ' (Peak: ' + (data.maxDrawdown?.peakDate || '—') + ' → Trough: ' + (data.maxDrawdown?.troughDate || '—') + ')' },
          { Key: 'SMA 50 / 200', Value: '৳' + (data.technical?.sma50 || '—') + ' / ৳' + (data.technical?.sma200 || '—') },
          { Key: 'Trend Signal', Value: data.technical?.trendSignal || '—' },
          { Key: 'Historical Median P/E', Value: (data.valuationCorridor?.medianPe || '—') + 'x' },
          { Key: 'P/E Percentile Rank', Value: (data.valuationCorridor?.pePercentileRank !== null ? data.valuationCorridor?.pePercentileRank + '%' : '—') },
          { Key: 'Mean Reversion Target', Value: (data.meanReversion?.targetPrice ? '৳' + data.meanReversion.targetPrice : '—') + ' (' + (data.meanReversion?.impliedUpside ? (data.meanReversion.impliedUpside > 0 ? '+' : '') + data.meanReversion.impliedUpside + '%' : '—') + ')' },
          { Key: 'Graham Intrinsic Value', Value: (data.grahamAndBuffett?.grahamNumber ? '৳' + data.grahamAndBuffett.grahamNumber : '—') },
          { Key: 'Total Price Timeline Points', Value: (data.timeline?.length || 0) + ' daily closing points' },
          { Key: 'Audited Statement Records', Value: (data.financialStatements?.length || 0) + ' annual disclosures' }
        ];
        rows = metrics;
      } else if (type === 'timeline' && data?.timeline) {
        rows = data.timeline;
      } else if (type === 'statements' && data?.statements) {
        rows = data.statements;
      } else if (typeof data === 'object' && data !== null) {
        // Flatten key-value pairs
        rows = Object.entries(data).map(([k, v]) => ({
          Key: k,
          Value: typeof v === 'object' ? JSON.stringify(v) : String(v)
        }));
      }

      rowsBadge.innerText = rows.length + ' records';
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 2rem; color: #94a3b8;">No records returned</td></tr>';
        dataTable.style.display = 'table';
        return;
      }

      // Generate Headers
      const keys = Object.keys(rows[0]);
      let trHead = '<tr>';
      keys.forEach(k => {
        trHead += '<th>' + k + '</th>';
      });
      trHead += '</tr>';
      head.innerHTML = trHead;

      // Generate Rows
      let trBody = '';
      rows.forEach(r => {
        trBody += '<tr>';
        keys.forEach(k => {
          const val = r[k];
          let formatted = val !== null && val !== undefined ? String(val) : '<span style="color: #64748b;">—</span>';
          let cls = '';
          
          if (k === 'symbol') {
            formatted = '<span class="sym-badge">' + formatted + '</span>';
          } else if (typeof val === 'number') {
            cls = 'num';
            if (k.toLowerCase().includes('change') || k.toLowerCase().includes('percent') || k.toLowerCase().includes('upside')) {
              cls += val > 0 ? ' pos' : (val < 0 ? ' neg' : '');
            }
          }
          trBody += '<td class="' + cls + '">' + formatted + '</td>';
        });
        trBody += '</tr>';
      });
      body.innerHTML = trBody;
      dataTable.style.display = 'table';
    }

    function filterTable() {
      const q = document.getElementById('tableSearch').value.toLowerCase();
      const trs = document.querySelectorAll('#tableBody tr');
      let visible = 0;
      trs.forEach(tr => {
        const text = tr.innerText.toLowerCase();
        if (text.includes(q)) {
          tr.style.display = '';
          visible++;
        } else {
          tr.style.display = 'none';
        }
      });
      document.getElementById('rowsBadge').innerText = visible + ' matching records';
    }

    // Trigger initial load
    loadActiveEndpoint();
  </script>
</body>
</html>`;
}
