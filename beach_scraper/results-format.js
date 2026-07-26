// Shared between the scraper (which writes one file per shard) and the merge
// step (which stitches them into the final prices.csv + summary.md).

const fs = require('fs');
const config = require('./config');

const CSV_HEADER = 'checkIn,checkOut,nights,price,pricePerNight,roomType,status,scrapedAt';
const CSV_COLUMNS = CSV_HEADER.split(',');

const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function csvRow(row) {
  // Totals are not comparable across stay lengths, so carry the per-night rate.
  const perNight = row.price ? Math.round(row.price / row.nights) : '';
  return [
    row.checkIn,
    row.checkOut,
    row.nights,
    row.price ?? '',
    perNight,
    quote(row.roomType), // room names contain commas
    quote(row.status), // so does error text
    row.scrapedAt,
  ].join(',');
}

// Minimal RFC4180-ish reader: enough for the columns above, which is all that
// ever lands in these files.
function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith(CSV_COLUMNS[0] + ',')) continue;

    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);

    const row = {};
    CSV_COLUMNS.forEach((c, i) => (row[c] = cells[i] ?? ''));
    row.nights = parseInt(row.nights, 10);
    row.price = row.price === '' ? null : parseInt(row.price, 10);
    rows.push(row);
  }
  return rows;
}

function writeSummary(results) {
  const found = results.filter((r) => r.price !== null && r.status === 'ok');
  if (found.length === 0) {
    fs.writeFileSync(config.summaryFile, '# Beaches TCI Price Summary\n\nNo prices found this run.\n');
    return;
  }

  const byPrice = [...found].sort((a, b) => a.price / a.nights - b.price / b.nights);
  const rows = byPrice
    .slice(0, 15)
    .map(
      (r) =>
        `| ${r.checkIn} | ${r.checkOut} | ${r.nights} nights | $${r.price.toLocaleString()} | ` +
        `$${Math.round(r.price / r.nights).toLocaleString()} | ${r.roomType} |`
    )
    .join('\n');

  // Month-by-month view, so a good window is obvious at a glance.
  const byMonth = new Map();
  for (const r of found) {
    const key = r.checkIn.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r.price / r.nights);
  }
  const monthRows = [...byMonth.entries()]
    .sort()
    .map(([month, rates]) => {
      const min = Math.round(Math.min(...rates));
      const max = Math.round(Math.max(...rates));
      const avg = Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
      return `| ${month} | ${rates.length} | $${min.toLocaleString()} | $${avg.toLocaleString()} | $${max.toLocaleString()} |`;
    })
    .join('\n');

  // Same start date at several lengths only happens in probe mode.
  const byStart = new Map();
  for (const r of found) {
    if (!byStart.has(r.checkIn)) byStart.set(r.checkIn, []);
    byStart.get(r.checkIn).push(r);
  }
  const lengthRows = [...byStart.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([start, rs]) => {
      rs.sort((a, b) => a.nights - b.nights);
      const cells = rs.map((r) => `${r.nights}n $${Math.round(r.price / r.nights).toLocaleString()}`);
      const rates = rs.map((r) => r.price / r.nights);
      const spread = Math.round(((Math.max(...rates) - Math.min(...rates)) / Math.min(...rates)) * 100);
      return `| ${start} | ${cells.join(' · ')} | ${spread}% |`;
    })
    .join('\n');

  // A sold-out week is a real answer about the resort, not a scraper failure.
  const soldOut = results.filter((r) => r.status.startsWith('sold_out'));
  const failed = results.filter((r) => r.status !== 'ok' && !r.status.startsWith('sold_out'));

  const summary = `# Beaches TCI Price Summary
Run: ${new Date().toISOString()}
Priced ${found.length} of ${results.length} date combinations${soldOut.length ? `, ${soldOut.length} sold out` : ''}${failed.length ? `, ${failed.length} failed` : ''}.

## Cheapest 15 by per-night rate

| Check In | Check Out | Stay | Total (USD) | Per night | Room |
|----------|-----------|------|-------------|-----------|------|
${rows}

## By month

| Month | Dates priced | Cheapest/night | Average/night | Priciest/night |
|-------|--------------|----------------|---------------|----------------|
${monthRows}
${lengthRows ? `
## Effect of stay length (same start date)

| Check In | Per-night rate by stay length | Spread |
|----------|-------------------------------|--------|
${lengthRows}
` : ''}${soldOut.length ? `
## Sold out

No availability for these start dates:

${soldOut.map((r) => `- ${r.checkIn} → ${r.checkOut} (${r.nights}n)`).join('\n')}
` : ''}${failed.length ? `
## Failures

${failed.slice(0, 10).map((r) => `- ${r.checkIn} (${r.nights}n): ${r.status}`).join('\n')}
${failed.length > 10 ? `\n...and ${failed.length - 10} more.` : ''}
` : ''}`;

  fs.writeFileSync(config.summaryFile, summary);
  return { found, byPrice };
}

module.exports = { CSV_HEADER, CSV_COLUMNS, csvRow, parseCsv, writeSummary };
