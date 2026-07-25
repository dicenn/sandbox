const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Date helpers ──────────────────────────────────────────────────────────────

function ageAtDate(birthDateStr, travelDate) {
  const birth = new Date(birthDateStr);
  const travel = new Date(travelDate);
  let age = travel.getFullYear() - birth.getFullYear();
  const m = travel.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && travel.getDate() < birth.getDate())) age--;
  return age;
}

function formatDate(date) {
  // MM/DD/YYYY — the format most booking engines expect
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getFullYear()}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Build every (checkIn, nights) combination we want to search
function buildSearchDates() {
  const combos = [];
  const { searchMonths, searchYearStart, searchYearEnd, stayLengths } = config;

  for (const nights of stayLengths) {
    for (let year = searchYearStart; year <= searchYearEnd; year++) {
      for (const month of searchMonths) {
        // Skip months that don't belong to this year in our window.
        // Dec belongs to searchYearStart; Jan-Apr belong to searchYearEnd.
        if (month === 12 && year !== searchYearStart) continue;
        if (month !== 12 && year !== searchYearEnd) continue;

        const daysInMonth = new Date(year, month, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
          const checkIn = new Date(year, month - 1, day);
          const checkOut = new Date(checkIn);
          checkOut.setDate(checkOut.getDate() + nights);
          combos.push({ checkIn, checkOut, nights });
        }
      }
    }
  }
  return combos;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function ensureResultsDir() {
  const dir = path.dirname(config.resultsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendRow(row) {
  const file = config.resultsFile;
  const isNew = !fs.existsSync(file);
  const line = [
    row.checkIn,
    row.checkOut,
    row.nights,
    row.price ?? '',
    row.roomType ?? '',
    row.status,
    row.scrapedAt,
  ].join(',');

  if (isNew) {
    fs.writeFileSync(file, 'checkIn,checkOut,nights,price,roomType,status,scrapedAt\n');
  }
  fs.appendFileSync(file, line + '\n');
}

// ── Summary markdown ──────────────────────────────────────────────────────────

function writeSummary(results) {
  const found = results.filter((r) => r.price !== null);
  if (found.length === 0) {
    fs.writeFileSync(config.summaryFile, '# Beaches TCI Price Summary\n\nNo prices found this run.\n');
    return;
  }

  found.sort((a, b) => a.price - b.price);
  const top10 = found.slice(0, 10);

  const rows = top10
    .map(
      (r) =>
        `| ${r.checkIn} | ${r.checkOut} | ${r.nights} nights | $${r.price.toLocaleString()} | ${r.roomType} |`
    )
    .join('\n');

  const summary = `# Beaches TCI Price Summary
Run: ${new Date().toISOString()}

## Top 10 Cheapest Options

| Check In | Check Out | Stay | Price (USD) | Room |
|----------|-----------|------|-------------|------|
${rows}

*Showing cheapest available room per date combination.*
`;

  fs.writeFileSync(config.summaryFile, summary);
  console.log('\n── Top 5 deals ──');
  top10.slice(0, 5).forEach((r) => {
    console.log(`  ${r.checkIn} → ${r.checkOut} (${r.nights}n): $${r.price.toLocaleString()} — ${r.roomType}`);
  });
}

// ── Sleep ─────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Core search ───────────────────────────────────────────────────────────────

// Navigate directly to the OBE search URL for each date combo and intercept
// the JSON API response that the React SPA fetches for room rates.
// The OBE (obe.beaches.com) is the Beaches booking engine — confirmed URL pattern.
async function interceptPriceSearch(page, checkIn, checkOut) {
  const { adults, children } = config.occupancy;
  const travelDate = isoDate(checkIn);
  const childAgeParams = children
    .map((c, i) => `child${i + 1}Age=${ageAtDate(c.birthDate, travelDate)}`)
    .join('&');

  const searchUrl =
    'https://obe.beaches.com/beaches/search/' +
    `?resortCode=BTCI` +
    `&checkIn=${formatDate(checkIn)}` +
    `&checkOut=${formatDate(checkOut)}` +
    `&adults=${adults}` +
    `&children=${children.length}` +
    `&${childAgeParams}`;

  return new Promise(async (resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, 35000);

    // The OBE React SPA calls an internal API for room rates.
    // Intercept any JSON response that contains rate/price/room data.
    const handler = async (response) => {
      if (resolved) return;
      const url = response.url();
      const ct = response.headers()['content-type'] || '';

      if (ct.includes('json') && (
        url.includes('/room') ||
        url.includes('/rate') ||
        url.includes('/avail') ||
        url.includes('/price') ||
        url.includes('/search') ||
        url.includes('api/')
      )) {
        try {
          const json = await response.json();
          const cheapest = extractCheapestRate(json);
          if (cheapest) {
            clearTimeout(timeout);
            resolved = true;
            page.off('response', handler);
            resolve(cheapest);
          }
        } catch {
          // not JSON or no rates in this response
        }
      }
    };

    page.on('response', handler);
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  });
}

// Walk a JSON blob looking for the cheapest room rate.
// SynXis responses typically nest rates inside a RatePlans or Rooms array.
function extractCheapestRate(json) {
  const candidates = [];

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }

    // Common SynXis field names for rate amounts
    const amount =
      obj.TotalRate?.Amount ??
      obj.RoomRate?.Amount ??
      obj.Rate?.Amount ??
      obj.AverageNightlyRate ??
      obj.DisplayRate ??
      obj.totalCost ??
      obj.total ??
      null;

    const room =
      obj.RoomType?.Name ??
      obj.RoomTypeName ??
      obj.RoomName ??
      obj.roomName ??
      obj.name ??
      'Unknown room';

    if (amount && typeof amount === 'number' && amount > 0) {
      candidates.push({ price: Math.round(amount), roomType: room });
    }

    Object.values(obj).forEach(walk);
  }

  walk(json);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.price - b.price);
  return candidates[0];
}

// ── DOM interaction ───────────────────────────────────────────────────────────

async function setSearchDates(page, checkIn, checkOut) {
  const checkInStr = formatDate(checkIn);
  const checkOutStr = formatDate(checkOut);

  // Try to find and update date inputs — selector names vary; these cover
  // the most common patterns used by SynXis and similar booking engines.
  const checkInSelectors = [
    '[data-testid="check-in-date"]',
    'input[name*="checkin" i]',
    'input[name*="check-in" i]',
    'input[name*="arrival" i]',
    'input[placeholder*="Check-in" i]',
    'input[placeholder*="Arrival" i]',
    '#checkin',
    '#arrivalDate',
  ];

  const checkOutSelectors = [
    '[data-testid="check-out-date"]',
    'input[name*="checkout" i]',
    'input[name*="check-out" i]',
    'input[name*="departure" i]',
    'input[placeholder*="Check-out" i]',
    'input[placeholder*="Departure" i]',
    '#checkout',
    '#departureDate',
  ];

  async function fillDate(selectors, value) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.fill('');
        await el.type(value, { delay: 80 });
        return true;
      }
    }
    return false;
  }

  const filledIn = await fillDate(checkInSelectors, checkInStr);
  const filledOut = await fillDate(checkOutSelectors, checkOutStr);

  if (!filledIn || !filledOut) {
    // If we can't find the inputs, the page structure changed — log and skip
    console.warn(`  Could not locate date inputs for ${checkInStr}`);
    return false;
  }

  // Submit / trigger search
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Search")',
    'button:has-text("Check Availability")',
    'button:has-text("Find Rooms")',
    '[data-testid="search-submit"]',
  ];

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      return true;
    }
  }

  // If no submit button found, pressing Enter usually works
  await page.keyboard.press('Enter');
  return true;
}

async function setOccupancy(page) {
  const { adults, children } = config.occupancy;

  // Try common occupancy/guest selectors
  const guestSelectors = [
    '[data-testid="guests"]',
    'button:has-text("Guests")',
    'button:has-text("Occupancy")',
    'button:has-text("Rooms & Guests")',
    '[aria-label*="guest" i]',
    '#guestSelector',
  ];

  let opened = false;
  for (const sel of guestSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.click();
      opened = true;
      break;
    }
  }

  if (!opened) {
    console.warn('  Could not open guest selector — skipping occupancy config');
    return;
  }

  await sleep(1000);

  // Set adults — look for +/- steppers or a select
  await adjustCounter(page, 'adult', adults);

  // Set children count first, then ages
  await adjustCounter(page, 'child', children.length);
  await sleep(500);

  // Fill child ages/birthdates
  for (let i = 0; i < children.length; i++) {
    const age = ageAtDate(children[i].birthDate, new Date().toISOString().slice(0, 10));

    // Some forms take age, some take birth year, some take birthdate
    const ageSelectors = [
      `select[name*="childAge${i}" i]`,
      `select[name*="child${i}Age" i]`,
      `input[name*="childAge${i}" i]`,
      `[data-child-index="${i}"] select`,
      `.child-age:nth-of-type(${i + 1})`,
    ];

    for (const sel of ageSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tag === 'select') {
          await el.selectOption({ value: String(age) }).catch(() =>
            el.selectOption({ label: String(age) })
          );
        } else {
          await el.fill(String(age));
        }
        break;
      }
    }
  }
}

async function adjustCounter(page, type, targetCount) {
  // Many booking engines use +/- buttons for guest counts
  const incrementSelectors = [
    `button[aria-label*="${type}" i][aria-label*="add" i]`,
    `button[aria-label*="${type}" i][aria-label*="increase" i]`,
    `[data-testid*="${type}-increment"]`,
    `.${type}-count + button`,
  ];

  const countSelectors = [
    `[data-testid*="${type}-count"]`,
    `input[name*="${type}Count" i]`,
    `span[class*="${type}Count" i]`,
  ];

  // Read current count
  let current = 0;
  for (const sel of countSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      const text = await el.innerText().catch(() => '');
      current = parseInt(text) || 0;
      break;
    }
  }

  const diff = targetCount - current;
  if (diff === 0) return;

  const action = diff > 0 ? 'add' : 'remove';
  const absCount = Math.abs(diff);

  for (const sel of incrementSelectors) {
    const el = page.locator(sel.replace('add', action).replace('increase', action === 'add' ? 'increase' : 'decrease')).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      for (let i = 0; i < absCount; i++) {
        await el.click();
        await sleep(300);
      }
      return;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  ensureResultsDir();

  // Clear results file for fresh run
  if (fs.existsSync(config.resultsFile)) fs.unlinkSync(config.resultsFile);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  const results = [];
  const scrapedAt = new Date().toISOString();

  try {
    // Go directly to the OBE (Online Booking Engine) to skip the marketing site.
    // Confirmed URL pattern: resortCode=BTCI for Turks & Caicos,
    // dates in MM/DD/YYYY format, child ages as child1Age/child2Age params.
    console.log('Initializing OBE session...');
    await page.goto('https://obe.beaches.com/', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await sleep(2000);

    const combos = buildSearchDates();
    console.log(`Running ${combos.length} date combinations...`);

    for (let i = 0; i < combos.length; i++) {
      const { checkIn, checkOut, nights } = combos[i];
      const checkInStr = isoDate(checkIn);
      const checkOutStr = isoDate(checkOut);

      process.stdout.write(`[${i + 1}/${combos.length}] ${checkInStr} → ${checkOutStr} (${nights}n)  `);

      try {
        const result = await interceptPriceSearch(page, checkIn, checkOut);

        if (result) {
          console.log(`$${result.price.toLocaleString()} — ${result.roomType}`);
          const row = { checkIn: checkInStr, checkOut: checkOutStr, nights, ...result, status: 'ok', scrapedAt };
          results.push(row);
          appendRow(row);
        } else {
          console.log('no price');
          appendRow({ checkIn: checkInStr, checkOut: checkOutStr, nights, price: null, roomType: null, status: 'no_price', scrapedAt });
        }
      } catch (err) {
        console.log(`error: ${err.message}`);
        appendRow({ checkIn: checkInStr, checkOut: checkOutStr, nights, price: null, roomType: null, status: `error: ${err.message}`, scrapedAt });
      }

      // Polite delay between requests
      if (i < combos.length - 1) {
        await sleep(config.delayBetweenSearchesMs + Math.random() * 3000);
      }
    }
  } finally {
    await browser.close();
  }

  writeSummary(results);
  console.log(`\nDone. Results written to ${config.resultsFile}`);
  console.log(`Summary written to ${config.summaryFile}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
