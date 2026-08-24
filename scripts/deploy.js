import { execSync } from 'child_process';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m'
};

function run(cmd, desc) {
  console.log(`\n${colors.cyan}▶ ${desc}...${colors.reset}`);
  try {
    const out = execSync(cmd, { stdio: 'inherit', encoding: 'utf-8' });
    return out;
  } catch {
    console.error(`\n${colors.red}✖ Failed during: ${desc}${colors.reset}`);
    process.exit(1);
  }
}

async function deploy() {
  console.log(`\n${colors.bright}${colors.blue}====================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.green}  🚀 DSE Live Build & 1-Command Cloud Deployer${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}====================================================${colors.reset}`);

  // Step 1: Test + audit gate. This repo (dse-pulse-backend) has no "build"
  // script -- the previous `npm run build` call here always failed at this
  // exact step (npm error: Missing script "build"), so this deployer never
  // actually got past step 1. Replaced 2026-08-23 with this project's real
  // pre-change gate (see CLAUDE.md: "Before changing anything in server/db.js,
  // server/index.js, ... run npm test && npm run audit:all ... confirm it
  // passes"). A deploy is exactly the moment that gate matters most -- this
  // is the one command capable of pushing straight to production.
  run('npm test', 'Running shared test suite');
  run('npm run audit:all', 'Running full fabrication/data audit (code + staging + main DB)');

  // Step 2: Check Git Status
  let status;
  try {
    status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  } catch {
    status = '';
  }

  const nowDhaka = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(new Date());

  const userMsg = process.argv.slice(2).join(' ').trim();
  const commitMsg = userMsg ? `Update: ${userMsg}` : `Deploy update (${nowDhaka} BST)`;

  if (status) {
    console.log(`\n${colors.yellow}Found modified/new files:${colors.reset}`);
    console.log(status.split('\n').map(l => `  ${l}`).join('\n'));
    console.log(`\n${colors.yellow}Staging and committing...${colors.reset}`);
    run('git add .', 'Staging all changes');
    run(`git commit -m "${commitMsg}"`, `Committing with message: "${commitMsg}"`);
  } else {
    console.log(`\n${colors.green}Working tree clean. Pushing latest commits to GitHub & Render...${colors.reset}`);
  }

  // Step 3: Push to GitHub (Auto-triggers Render deploy for both Backend & Frontend)
  run('git push origin main', 'Pushing to GitHub (Triggers Render Backend & Frontend)');

  console.log(`\n${colors.bright}${colors.green}====================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.green}  🎉 DEPLOYMENT TRIGGERED SUCCESSFULLY!${colors.reset}`);
  console.log(`${colors.bright}${colors.green}====================================================${colors.reset}`);
  console.log(`\n${colors.cyan}Live Services:${colors.reset}`);
  console.log(`  🌐 Frontend:  ${colors.bright}https://dse-frontend-m82u.onrender.com/${colors.reset}`);
  console.log(`  ⚙️  Backend:   ${colors.bright}https://dse-xvn2.onrender.com/${colors.reset}`);
  console.log(`  📦 GitHub:    ${colors.bright}https://github.com/iftekkhar/DSE${colors.reset}`);
  console.log(`\n${colors.yellow}Render is now building and deploying your latest changes across all services.${colors.reset}\n`);
}

deploy();
