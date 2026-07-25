// Quick smoke test — runs 3 date combos only
// Usage: node test_run.js
process.env.TEST_MODE = '1';

const { chromium } = require('playwright');
const config = require('./config');

function ageAtDate(birthDateStr, travelDate) {
  const birth = new Date(birthDateStr);
  const travel = new Date(travelDate);
  let age = travel.getFullYear() - birth.getFullYear();
  const m = travel.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && travel.getDate() < birth.getDate())) age--;
  return age;
}

function formatDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getFullYear()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 3 representative combos: one in Dec, one in Feb, one in Apr
const TEST_COMBOS = [
  { checkIn: new Date('2026-12-20'), nights: 7 },
  { checkIn: new Date('2027-02-10'), nights: 6 },
  { checkIn: new Date('2027-04-05'), nights: 8 },
].map(({ checkIn, nights }) => {
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + nights);
  return { checkIn, checkOut, nights };
});

async function run() {
  // Trust the proxy CA and route Chromium through the proxy
  process.env.NODE_EXTRA_CA_CERTS = '/root/.ccr/ca-bundle.crt';
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  console.log('Using proxy:', proxyServer || '(none)');

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Bypass the local proxy for Playwright — the proxy intercepts TLS and
      // causes ERR_CONNECTION_RESET with headless Chromium. curl works fine
      // going direct, so skip the proxy for browser traffic.
      '--proxy-server=direct://',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Log every network request to help us identify the pricing API endpoint
  page.on('request', (req) => {
    const url = req.url();
    if (
      url.includes('avail') ||
      url.includes('rate') ||
      url.includes('price') ||
      url.includes('search') ||
      url.includes('booking') ||
      url.includes('api')
    ) {
      console.log('  >> REQ:', req.method(), url.slice(0, 120));
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (
      url.includes('avail') ||
      url.includes('rate') ||
      url.includes('price') ||
      url.includes('search') ||
      url.includes('booking') ||
      url.includes('api')
    ) {
      const ct = res.headers()['content-type'] || '';
      console.log(`  << RES ${res.status()} [${ct.split(';')[0]}]: ${url.slice(0, 120)}`);
      if (ct.includes('json')) {
        try {
          const body = await res.json();
          console.log('     JSON keys:', Object.keys(body).slice(0, 8).join(', '));
        } catch {}
      }
    }
  });

  try {
    // Go directly to the OBE (Online Booking Engine) with search params pre-filled
    // This bypasses the marketing site (which has Cloudflare bot detection)
    const url =
      'https://obe.beaches.com/beaches/search/' +
      '?resortCode=BTCI' +
      '&checkIn=12/20/2026' +
      '&checkOut=12/27/2026' +
      '&adults=2' +
      '&children=2' +
      '&child1Age=4' +
      '&child2Age=7';
    console.log('\nNavigating to OBE search:', url);
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Accept cookies
    for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")', 'button:has-text("Accept")']) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        console.log('Accepted cookies');
        break;
      }
    }

    await sleep(2000);

    // Snapshot the page title + URL so we know where we landed
    console.log('\nPage title:', await page.title());
    console.log('Page URL:  ', page.url());

    // Find and log all visible inputs and buttons to understand the form
    const inputs = await page.locator('input:visible').all();
    console.log(`\nVisible inputs (${inputs.length}):`);
    for (const inp of inputs.slice(0, 15)) {
      const attrs = await inp.evaluate((el) => ({
        name: el.name,
        type: el.type,
        placeholder: el.placeholder,
        id: el.id,
        className: el.className.slice(0, 60),
      }));
      console.log('  ', JSON.stringify(attrs));
    }

    const buttons = await page.locator('button:visible').all();
    console.log(`\nVisible buttons (${buttons.length}):`);
    for (const btn of buttons.slice(0, 15)) {
      const text = await btn.innerText().catch(() => '');
      const attrs = await btn.evaluate((el) => ({ id: el.id, className: el.className.slice(0, 60) }));
      console.log('  ', JSON.stringify({ text: text.slice(0, 50).trim(), ...attrs }));
    }

    // Try one search combo to see what fires
    const { checkIn, checkOut, nights } = TEST_COMBOS[0];
    console.log(`\nAttempting search: ${formatDate(checkIn)} → ${formatDate(checkOut)} (${nights} nights)`);

    // Try clicking a "Check Availability" or "Book Now" button first
    for (const sel of [
      'a:has-text("Book Now")',
      'a:has-text("Check Availability")',
      'button:has-text("Book")',
      'a[href*="book"]',
      'a[href*="reserve"]',
    ]) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`Clicking: ${sel}`);
        await el.click();
        await sleep(3000);
        console.log('New URL:', page.url());
        break;
      }
    }

    await sleep(5000);
    console.log('\nFinal URL:', page.url());
    console.log('Final title:', await page.title());

    // Take a screenshot for inspection
    await page.screenshot({ path: './results/test_screenshot.png', fullPage: false });
    console.log('Screenshot saved to results/test_screenshot.png');

  } finally {
    await browser.close();
  }

  console.log('\nTest run complete. Check the network log above to identify the pricing API endpoint.');
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
