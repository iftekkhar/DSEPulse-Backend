# DSEPulse-Pipeline Engine

The dedicated data scraping, 20-year historical trajectory building, auditing, and ingestion engine for **DSEPulse**.

---

## 🏛 Architecture

```
DSEPulse-Pipeline Engine
├── src/scrapers/          # Real-time and Audited DSE web scrapers
├── src/builders/          # 20-Year multi-decade trajectories (Stock, DSEX, Audited Statements)
├── src/audit/             # Institutional data auditing & validation test suite
├── src/sync/              # Secure HTTP Ingestion Publisher (pushes to DSEPulse-Backend)
├── src/scheduler.js       # Asia/Dhaka Cron scheduler (Market Hours, EOD, Weekend audits)
└── src/cli.js             # On-demand CLI commands
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Test Suite
```bash
npm test
```

### 3. Run Automated Scheduler
```bash
npm start
```

### 4. On-Demand CLI Operations
```bash
# Scrape live market quotes, audit and sync to backend
npm run scrape:live

# Construct 20-year DSEX macro index, audit and sync
npm run build:dsex

# Run master sync (DSEX + benchmark stocks)
npm run sync
```
