// Stitches the per-shard CSVs written by parallel scraper jobs into the final
// prices.csv + summary.md. Run after all shards finish.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { CSV_HEADER, csvRow, parseCsv, writeSummary } = require('./results-format');

const dir = path.dirname(config.resultsFile);

const shardFiles = fs
  .readdirSync(dir)
  .filter((f) => /^prices\.shard-\d+\.csv$/.test(f))
  .sort();

if (shardFiles.length === 0) {
  console.error(`No shard files found in ${dir}. Nothing to merge.`);
  process.exit(1);
}

const rows = shardFiles.flatMap((f) => {
  const parsed = parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log(`  ${f}: ${parsed.length} rows`);
  return parsed;
});

// Shards cover disjoint combos, but a re-run could overlap — keep the newest.
const byKey = new Map();
for (const r of rows) {
  const key = `${r.checkIn}|${r.nights}`;
  const prev = byKey.get(key);
  if (!prev || r.scrapedAt > prev.scrapedAt) byKey.set(key, r);
}

const merged = [...byKey.values()].sort(
  (a, b) => a.checkIn.localeCompare(b.checkIn) || a.nights - b.nights
);

fs.writeFileSync(config.resultsFile, CSV_HEADER + '\n' + merged.map(csvRow).join('\n') + '\n');
writeSummary(merged);

const ok = merged.filter((r) => r.status === 'ok');
console.log(
  `\nMerged ${shardFiles.length} shards → ${merged.length} combos ` +
    `(${ok.length} priced, ${merged.length - ok.length} failed)`
);
console.log(`Wrote ${config.resultsFile} and ${config.summaryFile}`);

// Clean up so the shard files don't get committed alongside the merged output.
for (const f of shardFiles) fs.unlinkSync(path.join(dir, f));
