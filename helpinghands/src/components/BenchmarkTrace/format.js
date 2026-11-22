/** `1.2 s`, `340 ms`, `2 m 5 s`; `–` for an unknown figure. */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} m ${whole % 60} s`;
}

export const formatTokens = value => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '–');

export const formatCost = usd => (Number.isFinite(usd) ? `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}` : '–');

/** An attempt's cost from its accounting: the settled sum, with a `+` while some of its calls are reserved or uncertain (a lower bound). */
export const accountingCost = accounting => `${formatCost(accounting?.totals?.settled_usd)}${
  Number.isFinite(accounting?.totals?.settled_usd) && accounting.calls.some(call => call.admission.status !== 'settled') ? '+' : ''}`;
