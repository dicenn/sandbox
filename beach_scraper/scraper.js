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
//                                              only the two visible months are
//                                              mounted, so page forward first
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
    ':text("HIDE CHAT")',
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
  await killChatWidget(page);
}

// The NICE CXone chat panel auto-expands over the "Number of Guests" field and
// eats the click meant for it. Removing it once is not enough: it opens on its
// own timer, well after page load, so it has to be swept repeatedly.
//
// Matches on the vendor's own markers (iframe src, id/class, or the panel's
// "HIDE CHAT"/"Powered by NICE CXone" chrome) rather than on position or
// z-index, which missed it entirely on run 8.
const CHAT_JANITOR = `(() => {
  const vendor = /cxone|gomoxie|inqms|nice-?incontact|livechat|inq-?chat/i;
  const sweep = () => {
    try {
      for (const f of document.querySelectorAll('iframe')) {
        if (vendor.test((f.src || '') + ' ' + f.id + ' ' + f.className)) f.remove();
      }
      for (const el of document.querySelectorAll('div,section,aside')) {
        if (el.childElementCount > 40) continue;
        if (vendor.test(el.id + ' ' + el.className)) { el.remove(); continue; }
        const t = el.textContent || '';
        if (/HIDE CHAT|END CHAT|Powered by NICE CXone/i.test(t) && t.length < 2000) el.remove();
      }
    } catch {}
  };
  sweep();
  setInterval(sweep, 500);
})()`;

async function killChatWidget(page) {
  await page.evaluate(CHAT_JANITOR).catch(() => {});
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

// Two ways to click, because neither is sufficient alone.
//
// 'real' dispatches actual pointer events, which is what react-aria's usePress
// listens for — programmatic clicks do NOT open its popovers (run 9 regression).
// 'dom' ignores geometry, which is the only way through an overlay that is
// sitting on top of the target.
//
// A 'dom' click always "succeeds" mechanically even when no handler reacts, so
// it can never be trusted on its own: callers must verify the intended effect.
async function clickWith(locator, mode) {
  if (mode === 'dom') {
    return locator.evaluate((el) => el.click()).then(() => true).catch(() => false);
  }
  return locator.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
}

async function robustClick(locator) {
  if (await clickWith(locator, 'real')) return true;
  return clickWith(locator, 'dom');
}

// Open a popover and confirm it actually rendered. The trigger is a react-aria
// button whose panel mounts on demand, so a click that lands early is a no-op.
async function openPopover(page, triggerTestId, panelTestId, log) {
  const trigger = page.locator(`[data-testid="${triggerTestId}"] [data-testid="button-ui"]`).first();
  const panel = page.locator(`[data-testid="${panelTestId}"]`).first();

  // Real clicks drive react-aria; the dom pass is only there in case something
  // is covering the trigger despite the sweeper.
  const modes = ['real', 'dom', 'real'];
  for (let attempt = 0; attempt < modes.length; attempt++) {
    await waitIdle(page);
    await killChatWidget(page); // it re-opens on its own timer
    await clickWith(trigger, modes[attempt]);

    if (await panel.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
      log(`${panelTestId} opened (${modes[attempt]} click, attempt ${attempt + 1})`);
      return true;
    }
    log(`${panelTestId} did not open via ${modes[attempt]} click (${attempt + 1}/${modes.length})`);
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
    await robustClick(cell);
    log(`${label} = ${isoDate(d)}`);
    await sleep(1500);
  }

  // Calendar usually auto-closes once the range is complete; Escape if not.
  await page.keyboard.press('Escape').catch(() => {});
  await waitIdle(page);

  // 4 ─ Guests. Counters start at 2 adults / 0 children, so nudge to target.
  // The OBE bands are Adults (16+), Children (2-15), Infants (0-2); both kids
  // in config land in Children for every date in the search window.
  // A wrong count here silently prices the wrong trip, so refuse to continue.
  if (!(await openPopover(page, 'select-guests-ui', 'counter-ui', log))) {
    throw new Error('guest popover never opened');
  }
  await setCounter(page, 'Adults', adults, log);
  await setCounter(page, 'Children', children.length, log);
  await page.keyboard.press('Escape').catch(() => {});
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
//
// counter-ui is the <input> itself, not a wrapper — the +/- buttons are its
// siblings. It is also disabled, so the value has to be read as a form value
// rather than as text (innerText on an input is always empty).
async function setCounter(page, name, target, log) {
  const field = page.locator(`input[data-testid="counter-ui"][aria-label="${name}"]`).first();
  const inc = page.locator(`[aria-label="Increase ${name}"]`).first();
  const dec = page.locator(`[aria-label="Decrease ${name}"]`).first();

  const readValue = async () => {
    let v = await field.inputValue().catch(() => null);
    if (v === null || v === '') v = await field.getAttribute('value').catch(() => null);
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };

  let current = await readValue();
  if (current === null) throw new Error(`could not read ${name} counter`);

  let guard = 0;
  while (current !== target && guard++ < 10) {
    await robustClick(current < target ? inc : dec);
    await sleep(700);
    const next = await readValue();
    if (next === null || next === current) break; // stopped responding — bail
    current = next;
  }
  log(`${name} = ${current} (wanted ${target})`);
  if (current !== target) throw new Error(`${name} stuck at ${current}, wanted ${target}`);
}

// Room rates never arrive as JSON — the OBE server-renders the room step, so
// the prices only exist in the DOM. Pull every "$N,NNN" that sits in its own
// element, then walk up to the surrounding card to name the room.
async function extractRoomsFromDom(page) {
  return page
    .evaluate(() => {
      const rooms = [];
      for (const el of document.querySelectorAll('div,span,p,strong,h1,h2,h3,h4,h5')) {
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join('')
          .trim();

        const m = own.match(/^\$\s?([\d,]+)$/);
        if (!m) continue;
        const price = parseInt(m[1].replace(/,/g, ''), 10);
        if (!Number.isFinite(price) || price < 500) continue; // skip fees/discounts

        // Climb to the card: the first ancestor that reads like a room block.
        let node = el;
        let roomType = 'Unknown room';
        for (let i = 0; i < 8 && node.parentElement; i++) {
          node = node.parentElement;
          const lines = node.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
          if (lines.length >= 3 && !lines[0].includes('$') && lines[0].length > 5 && lines[0].length < 120) {
            roomType = lines[0];
            break;
          }
        }
        rooms.push({ price, roomType });
      }

      // Same room can surface more than once; keep one entry per name+price.
      const seen = new Set();
      return rooms.filter((r) => {
        const k = `${r.roomType}|${r.price}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    })
    .catch(() => []);
}

async function interceptPriceSearch(page, checkIn, checkOut) {
  // The OBE echoes the search back on this endpoint, which is the only
  // trustworthy confirmation that the form applied what we intended.
  let vacation = null;
  const resHandler = async (response) => {
    if (!response.url().includes('/api/session/subSession/data')) return;
    try {
      const j = await response.json();
      if (j && j.vacation && j.vacation.rstCode) vacation = j.vacation;
    } catch {}
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

    // The room step announces itself with "N ROOMS FOUND".
    await page
      .getByText(/ROOMS FOUND/i)
      .first()
      .waitFor({ state: 'visible', timeout: 60000 })
      .catch(() => {});
    await sleep(5000); // let the first batch of cards paint

    const rooms = await extractRoomsFromDom(page);
    rooms.sort((a, b) => a.price - b.price);

    if (TEST_MODE) {
      await page.screenshot({ path: `./results/step2_rooms_${isoDate(checkIn)}.png`, fullPage: true }).catch(() => {});
      console.log(`    session echo: ${JSON.stringify(vacation && {
        rst: vacation.rstCode, in: vacation.checkIn, out: vacation.checkOut,
        adults: vacation.adults, children: vacation.children, air: vacation.airIncluded,
      })}`);
      console.log(`    ${rooms.length} rooms parsed; cheapest 3: ` +
        rooms.slice(0, 3).map((r) => `$${r.price} ${r.roomType}`).join(' | '));
    }

    // Refuse to record a price that was quoted for the wrong search.
    const want = { in: isoDate(checkIn), out: isoDate(checkOut), children: config.occupancy.children.length };
    if (vacation && (vacation.checkIn !== want.in || vacation.checkOut !== want.out ||
                     vacation.children !== want.children || vacation.adults !== config.occupancy.adults)) {
      throw new Error(
        `search mismatch: got ${vacation.checkIn}..${vacation.checkOut} ` +
        `${vacation.adults}a/${vacation.children}c, wanted ${want.in}..${want.out} ` +
        `${config.occupancy.adults}a/${want.children}c`
      );
    }

    return rooms[0] || null;
  } finally {
    page.off('response', resHandler);
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

  // Arm the chat sweeper before any document script runs, so the widget is
  // gone on every navigation rather than only when we remember to ask.
  await context.addInitScript(CHAT_JANITOR);

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
