/**
 * Relative-time formatter shared by Comments, Annotations, and Discussions.
 *
 * Renders an ISO-8601 timestamp as 'just now', 'Nm ago', 'Nh ago', or 'Nd ago',
 * falling back to a localized date once the gap reaches `recentDays`.
 *
 * @param {string} iso  ISO-8601 timestamp.
 * @param {object} [options]
 * @param {number} [options.recentDays=30]  Day cutoff before the date fallback.
 * @param {boolean} [options.withTime=false]  Append hour and minute to the fallback.
 * @returns {string}
 */
export function formatTime(iso, {recentDays = 30, withTime = false} = {}) {
  const d = new Date(iso);
  const diffMin = Math.floor((new Date() - d) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < recentDays) return `${diffDay}d ago`;
  const opts = {year: 'numeric', month: 'short', day: 'numeric'};
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  return d.toLocaleDateString(undefined, opts);
}
