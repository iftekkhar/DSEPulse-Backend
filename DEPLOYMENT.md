# DSE Live Scraper & SQLite Analytics Terminal (100% Free)

This backend runs as a standalone **Official DSE Scraper, SQLite Database & Analytics API**.

---

## 🕒 DSE Automated Schedules (Market Open Only)
- **Market Hours Scrape**: Every hour from **10:00 AM to 3:00 PM BST, Sunday to Thursday** (`0 10-15 * * 0-4`)
- **Daily Closing Archive**: **3:30 PM BST, Sunday to Thursday** (`30 15 * * 0-4`) $\rightarrow$ commits official closing prices to SQLite (`data/dse.db`)
- **Weekly Fundamentals Crawl**: **Saturdays at 12:00 PM BST** (`0 12 * * 6`) $\rightarrow$ crawls audited EPS, NAVPS, and P/E from official DSE company disclosures
- **Historical Data**: Managed in embedded **SQLite (`data/dse.db`)** with instant **Excel (.xlsx)** export via `/api/export/excel`.

---

## 🚀 Step 1: Deploy Backend to Render.com (100% Free)

1. Push your repository to **GitHub**:
   ```bash
   git add .
   git commit -m "Configure backend deployment and auto-scraper"
   git push origin main
   ```
2. Go to **[render.com](https://render.com)** and sign in with GitHub (No credit card needed).
3. Click **New +** $\rightarrow$ **Web Service**.
4. Connect your `dse-dashboard` (or `dse`) repository.
5. Configure Settings:
   - **Name**: `dse-backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server/index.js`
   - **Plan**: `Free`
6. Add Environment Variables:
   - `TZ` = `Asia/Dhaka`
   - `PORT` = `5001`
7. Click **Deploy Web Service**. You will receive your live backend URL (e.g. `https://dse-backend.onrender.com`).

---

## 🔗 Step 2: Connect Your Frontend to the Live Backend

In your local project root, edit or create `.env`:
```env
VITE_API_URL=https://your-dse-backend.onrender.com
```
Now, whenever you run your local frontend (`npm run dev`), it will fetch real-time DSE data and trigger live syncs directly against your deployed cloud backend!

---

## 🔄 Free 24/7 Auto-Trigger via GitHub Actions (Zero Downtime)
If your free host goes to sleep during inactivity:
1. In your GitHub repository, go to **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions**.
2. Add a Repository Secret:
   - **Name**: `LIVE_APP_URL`
   - **Value**: `https://your-app.onrender.com`
3. The included workflow [`.github/workflows/auto_scrape.yml`](file:///.github/workflows/auto_scrape.yml) will trigger every hour from 9:00 AM to 6:00 PM BST, pinging your live server and committing updated data snapshots directly.
