// All parameters for the Beaches.com price scraper
const config = {
  resort: 'Beaches Turks & Caicos',

  occupancy: {
    adults: 2,
    children: [
      { birthDate: '2022-04-01' }, // age ~4
      { birthDate: '2019-10-13' }, // age ~6/7
    ],
  },

  // Only search start dates in these months (1=Jan, 12=Dec)
  searchMonths: [12, 1, 2, 3, 4],

  // First year to search December in (Dec 2026 through Apr 2027)
  searchYearStart: 2026,
  searchYearEnd: 2027,

  // Stay lengths to try (nights)
  stayLengths: [6, 7, 8],

  // Delay between searches in ms — slow and human-like
  delayBetweenSearchesMs: 8000,

  // Where results are written
  resultsFile: './results/prices.csv',
  summaryFile: './results/summary.md',
};

module.exports = config;
