# DSE Pulse Backend Engine (Dhaka Stock Exchange Institutional Server)

Production-ready institutional backend service and master SQLite database engine for Dhaka Stock Exchange (DSE).

## Architecture & Data Flow
- **Port:** `5001` (Configurable via `PORT` environment variable)
- **Timezone Engine:** `Asia/Dhaka` (BST UTC+6)
- **Database:** SQLite (`data/dse.db`)
- **Key Automation Schedules:**
  - **Job 1 (Closing Prices Archive):** Sun–Thu @ 15:30 BST (`30 15 * * 0-4`)
  - **Job 3 (Daily Fundamentals Delta):** Sun–Thu @ 16:00 BST (`0 16 * * 0-4`)
  - **Job 4 (Market Breadth Pulse):** Every 30m during market hours (10:00–15:00 BST, Sun–Thu)
  - **Weekly Audited EPS Crawler:** Every Saturday @ 10:00 BST (`0 10 * * 6`)

## Getting Started
```bash
npm install
npm start
```
