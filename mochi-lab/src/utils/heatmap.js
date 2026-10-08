// Pure calendar-heatmap layout shared by the Activity and Writing heatmaps on
// the analytics page. No UI-framework or bundler imports, so it can be
// unit-tested directly under `node --test`.

/**
 * Pack a trailing day window into GitHub-style heatmap columns (weeks).
 *
 * @param {Record<string, number>} valuesByDate  Map of "YYYY-MM-DD" to count.
 * @param {object} options
 * @param {number} options.days                  Number of trailing days to include (window length).
 * @param {Date} options.today                   Most recent day in the window (inclusive).
 * @param {boolean} [options.trailingPad=false]  Pad the final partial week with nulls up to length 7.
 * @returns {Array<Array<{ key: string, count: number, day: number } | null>>}
 *          Weeks (columns), each holding 7 entries that are either a cell or
 *          null. The first week is leading-padded with nulls so the first real
 *          cell lands on its day-of-week row.
 */
export function buildHeatmapWeeks(valuesByDate, { days, today, trailingPad = false }) {
  const values = valuesByDate || {};

  // One cell per day, oldest first, ending on `today`.
  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const count = values[key] || 0;
    cells.push({ key, count, day: d.getDay() });
  }

  // Arrange into columns of 7 rows (Sun=0 ... Sat=6).
  const weeks = [];
  let week = [];
  const firstDay = cells[0]?.day || 0;
  for (let i = 0; i < firstDay; i++) week.push(null);
  for (const cell of cells) {
    week.push(cell);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    if (trailingPad) {
      while (week.length < 7) week.push(null);
    }
    weeks.push(week);
  }

  return weeks;
}
