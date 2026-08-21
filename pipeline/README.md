# DSEPulse-Pipeline Engine (Dedicated Historical & Staging Environment)

A dedicated, isolated data pipeline for constructing 20-year multi-decade equity price trajectories, DSEX macro index curves, 21-year annual audited financial statements, and running institutional audit certifications.

---

## 🔒 Security & Data Integrity Rule
> **Strict Promotion Policy**: This pipeline writes **ONLY** to its own Staging Database (`pipeline/data/staging.db`). It will **NEVER** update or write to the Main (Backend) Production Database on its own. 
> Promotion to the Main Database requires:
> 1. Passing all institutional audit and consistency checks with **0 blocking errors**.
> 2. Explicit manual user invocation with `--confirm`.

---

## 🏛 Architecture

```
DSEPulse-Pipeline Engine
├── data/
│   └── staging.db                     # Dedicated Pipeline Staging Database (SQLite)
├── src/
│   ├── db/staging_db.js               # Staging DB schema, tables & operations
│   ├── scrapers/
│   │   └── audited_fundamentals_scraper.js # 20-Year corporate disclosure crawler
│   ├── builders/
│   │   ├── history_builder.js         # 2005–2026 calibrated equity timelines -> staging.db
│   │   ├── dsex_builder.js            # 2005–2026 continuous DSEX curve -> staging.db
│   │   └── fundamentals_builder.js    # 2005–2025 audited statements -> staging.db
│   ├── audit/
│   │   ├── auditor.js                 # Institutional audit rules & consistency checks
│   │   ├── audit_runner.js            # Staging DB audit inspector & reporter
│   │   └── test_suite.js              # Unit & integration assertions
│   ├── promotion/
│   │   └── manual_promoter.js         # Guarded manual promotion tool
│   └── cli.js                         # On-demand CLI commands
```

---

## 🚀 CLI Commands

### 1. Initialize Staging Database
```bash
npm run db:init
```

### 2. Construct Historical Trajectories into Staging DB
```bash
# Build 20-Year DSEX Index Curve
npm run build:dsex

# Build 20-Year Price History for a specific stock
node src/cli.js --build-history BRACBANK

# Build 20-Year Audited Statements for a specific stock
node src/cli.js --build-statements BRACBANK

# Build Master Dataset into Staging DB
node src/cli.js --build-all-staging
```

### 3. Run Institutional Audit & View Certification Reports
```bash
# Execute Audit over all staging tables
npm run audit

# View audit logs & certification history
npm run report
```

### 4. Run Automated Test Suite
```bash
npm test
```

### 5. Manual User Promotion to Main Database
```bash
# Promotes certified records to Main Backend DB ONLY with explicit confirmation
npm run promote:main --confirm
```
