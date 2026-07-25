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
  if (process.env.TEST_MODE === 'true') {
    // 3 representative combos spread across the search window
    return [
      { checkIn: new Date('2026-12-20'), checkOut: new Date('2026-12-27'), nights: 7 },
      { checkIn: new Date('2027-02-10'), checkOut: new Date('2027-02-16'), nights: 6 },
      { checkIn: new Date('2027-04-05'), checkOut: new Date('2027-04-13'), nights: 8 },
    ];
  }

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

const TEST_MODE = process.env.TEST_MODE === 'true';

// ── Core search ───────────────────────────────────────────────────────────────

// The OBE ignores our URL query params — it always renders an EMPTY step-1
// "VACATION" form (confirmed by screenshot: resort unselected, dates blank).
// So we drive the form directly. Selectors below were all confirmed by
// inspecting the served step-1 HTML:
//
//   [data-testid="select-resort-ui"] select    native <select>, BTC = Turks & Caicos
//   [data-testid="radio-no-flights-ui"]        visually-hidden radio, value="false"
//   [data-testid="select-dates-ui"]            opens the range calendar popover
//   [data-testid="calendar-cell-ui"][data-date="YYYY-MM-DD"]
//                                              every day Jul-2026..Dec-2028 is
//                                              pre-rendered, so no month paging
//   [data-testid="select-guests-ui"]           opens Adults/Children/Infants counters
//   [data-testid="form-vacation-submit-button-ui"]  → advances to step-2 (ROOM)
//
// Child birthdates are NOT collected here; the wizard asks for them at the later
// GUESTS step, so room pricing only needs the adult/child counts.
// A ketch cookie banner and a chat widget both float above the form and will
// swallow clicks aimed at what is underneath them. Best-effort: neither is
// guaranteed to appear, so every failure here is ignored.
async function dismissOverlays(page) {
  const dismissals = [
    'button:has-text("Accept All")',
    '#onetrust-accept-btn-handler',
    '[class*="ketch"] button:has-text("Accept")',
    'button[aria-label*="close" i]',
    'button[title*="close" i]',
  ];
  for (const sel of dismissals) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      await el.click({ force: true, timeout: 3000 }).catch(() => {});
      await sleep(400);
    }
  }
}

// The hydrated calendar only mounts two months at a time behind a next arrow,
// even though the server-rendered HTML contains every day through 2028. Page
// forward until the target day exists. The arrow carries no label or testid,
// so mark it in-page: inside the calendar, the nav buttons are the icon-only
// ones that aren't day cells. Fall back to react-aria's PageDown handling.
async function pageCalendarTo(page, targetIso, log, maxPages = 40) {
  const cell = `[data-testid="calendar-cell-ui"][data-date="${targetIso}"]`;

  for (let i = 0; i <= maxPages; i++) {
    if (await page.locator(cell).first().count()) {
      if (i) log(`paged ${i}x to reach ${targetIso}`);
      return true;
    }

    const advanced = await page
      .evaluate(() => {
        const cal = document.querySelector('[data-testid="calendar-ui"]');
        if (!cal) return false;
        const navs = [...cal.querySelectorAll('button')].filter(
          (b) => !b.closest('[data-testid="calendar-cell-ui"]') && !b.innerText.trim()
        );
        const next = navs[navs.length - 1]; // rightmost icon button = next
        if (!next || next.disabled) return false;
        next.click();
        return true;
      })
      .catch(() => false);

    if (!advanced) {
      await page.keyboard.press('PageDown').catch(() => {});
    }
    await sleep(600);
  }
  return false;
}

// Selecting a resort kicks off a fetch that covers the form with a loading
// overlay; clicking through it silently does nothing, so always settle first.
async function waitIdle(page) {
  await page
    .locator('[data-testid="loading-overlay-ui"]')
    .waitFor({ state: 'hidden', timeout: 20000 })
    .catch(() => {});
  await sleep(800);
}

// Open a popover and confirm it actually rendered. The trigger is a react-aria
// button whose panel mounts on demand, so a click that lands early is a no-op.
async function openPopover(page, triggerTestId, panelTestId, log) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitIdle(page);
    await page
      .locator(`[data-testid="${triggerTestId}"] [data-testid="button-ui"]`)
      .first()
      .click({ force: true })
      .catch(() => {});

    const panel = page.locator(`[data-testid="${panelTestId}"]`).first();
    if (await panel.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
      log(`${panelTestId} opened (attempt ${attempt})`);
      return true;
    }
    log(`${panelTestId} did not open, retrying (${attempt}/3)`);
  }
  return false;
}

async function fillVacationForm(page, checkIn, checkOut) {
  const { adults, children } = config.occupancy;
  const log = (m) => TEST_MODE && console.log(`    ${m}`);

  // 1 ─ Resort (native <select>, so this is reliable)
  await page.selectOption('[data-testid="select-resort-ui"] select', 'BTC');
  log('resort = BTC');
  await waitIdle(page);

  // 2 ─ Decline flights, so the quote is room-only
  await page.locator('[data-testid="radio-no-flights-ui"]').check({ force: true });
  log('flights = no');
  await waitIdle(page);

  // 3 ─ Dates. One shared range calendar backs both the check-in and check-out
  // triggers, so we open it once and click both day cells by data-date.
  if (!(await openPopover(page, 'select-dates-ui', 'calendar-ui', log))) {
    await dumpCalendarDiagnostics(page, checkIn, log);
    throw new Error('calendar popover never opened');
  }

  for (const [label, d] of [['check-in', checkIn], ['check-out', checkOut]]) {
    if (!(await pageCalendarTo(page, isoDate(d), log))) {
      await dumpCalendarDiagnostics(page, checkIn, log);
      throw new Error(`${label} cell ${isoDate(d)} never rendered`);
    }
    const cell = page.locator(`[data-testid="calendar-cell-ui"][data-date="${isoDate(d)}"]`).first();
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    if ((await cell.getAttribute('data-disabled').catch(() => null)) === 'true') {
      throw new Error(`${label} ${isoDate(d)} is unavailable`);
    }
    await cell.click({ force: true });
    log(`${label} = ${isoDate(d)}`);
    await sleep(1500);
  }

  // Calendar usually auto-closes once the range is complete; Escape if not.
  await page.keyboard.press('Escape').catch(() => {});
  await waitIdle(page);

  // 4 ─ Guests. Counters start at 2 adults / 0 children, so nudge to target.
  if (await openPopover(page, 'select-guests-ui', 'counter-ui', log)) {
    await setCounter(page, 'Adults', adults, log);
    await setCounter(page, 'Children', children.length, log);
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    log('guest popover never opened — falling back to form defaults');
  }
  await waitIdle(page);
}

// When the calendar misbehaves, capture enough to fix it without another
// blind round trip: what mounted, what the popover looks like, what is on screen.
async function dumpCalendarDiagnostics(page, checkIn, log) {
  const counts = await page
    .evaluate(() => ({
      calendarUi: document.querySelectorAll('[data-testid="calendar-ui"]').length,
      cells: document.querySelectorAll('[data-testid="calendar-cell-ui"]').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      sampleDates: [...document.querySelectorAll('[data-testid="calendar-cell-ui"]')]
        .slice(0, 5)
        .map((n) => n.getAttribute('data-date')),
    }))
    .catch(() => null);
  log(`calendar diagnostics: ${JSON.stringify(counts)}`);
  await page
    .screenshot({ path: `./results/calendar_fail_${isoDate(checkIn)}.png`, fullPage: true })
    .catch(() => {});
}

// Drive one +/- stepper to a target value using its aria-labels.
async function setCounter(page, name, target, log) {
  const inc = page.locator(`[aria-label="Increase ${name}"]`).first();
  const dec = page.locator(`[aria-label="Decrease ${name}"]`).first();

  // The current value is the only number rendered inside the counter row.
  const readValue = async () => {
    const txt = await page
      .locator(`[data-testid="counter-ui"]:has([aria-label="Increase ${name}"])`)
      .first()
      .innerText()
      .catch(() => '');
    const m = txt.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  let current = await readValue();
  if (current === null) {
    log(`${name}: could not read counter, skipping`);
    return;
  }

  let guard = 0;
  while (current !== target && guard++ < 10) {
    await (current < target ? inc : dec).click({ force: true }).catch(() => {});
    await sleep(700);
    const next = await readValue();
    if (next === null || next === current) break; // stopped responding — bail
    current = next;
  }
  log(`${name} = ${current} (wanted ${target})`);
}

async function interceptPriceSearch(page, checkIn, checkOut) {
  const NOISY = ['datadoghq', 'ketchcdn', 'gomoxie', 'pinterest', 'reddit', 'yimg',
                 'xu-09276', 'google', 'facebook', 'tealiumiq', 'demdex', 'adobedtm'];
  const isNoisy = (u) => NOISY.some((n) => u.includes(n));

  let best = null;
  const captured = [];

  const resHandler = async (response) => {
    const url = response.url();
    if (isNoisy(url)) return;
    if (!(response.headers()['content-type'] || '').includes('json')) return;

    let text;
    try { text = await response.text(); } catch { return; }
    if (text.length < 40) return;

    let json;
    try { json = JSON.parse(text); } catch { return; }

    const cheapest = extractCheapestRate(json);
    if (cheapest && (!best || cheapest.price < best.price)) {
      best = cheapest;
      if (TEST_MODE) console.log(`    ✓ price candidate $${cheapest.price} — ${cheapest.roomType}`);
    }

    // In TEST_MODE keep the raw bodies so we can write an exact extractor later.
    if (TEST_MODE && text.length > 200) captured.push({ url, body: text.slice(0, 20000) });
  };

  page.on('response', resHandler);

  try {
    await page.goto('https://obe.beaches.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000); // let React hydrate the form
    await dismissOverlays(page);

    await fillVacationForm(page, checkIn, checkOut);

    if (TEST_MODE) {
      await page.screenshot({ path: `./results/step1_filled_${isoDate(checkIn)}.png` }).catch(() => {});
    }

    // The cookie banner is pinned to the bottom of the viewport, right where
    // CONTINUE sits, so clear it again before committing the form.
    await dismissOverlays(page);
    await page.locator('[data-testid="form-vacation-submit-button-ui"]').click({ force: true });
    if (TEST_MODE) console.log('    submitted → waiting for room results');

    // Wait for the ROOM step to actually render rather than sleeping blindly.
    await page
      .waitForFunction(() => /room/i.test(location.href) || /per (night|person)/i.test(document.body.innerText),
                       { timeout: 45000 })
      .catch(() => {});
    await sleep(8000); // let all rate calls settle

    if (TEST_MODE) {
      await page.screenshot({ path: `./results/step2_rooms_${isoDate(checkIn)}.png`, fullPage: true }).catch(() => {});
      console.log(`    final URL: ${page.url()}`);
      fs.writeFileSync(`./results/api_${isoDate(checkIn)}.json`, JSON.stringify(captured, null, 2));
      console.log(`    captured ${captured.length} JSON responses`);
    }
  } finally {
    page.off('response', resHandler);
  }

  return best;
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
    // Each combo loads the OBE fresh and drives the step-1 form itself,
    // so there is no shared session to set up here.
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
