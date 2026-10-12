/**
 * Fuzzy search scorer shared by the Workbench's quick open, the CommandPalette
 * and the command bar. Every query character must appear in the text in order,
 * ignoring case; of all the ways to place them, the best scoring one is kept,
 * and `indices` names the text positions it matched (for <Highlight>).
 *
 * Each matched character scores MATCH, plus BOUNDARY at the start of the text
 * or after / - _ . or a space, plus CAMEL on a lowercase-to-uppercase step, plus
 * CONSECUTIVE when it directly follows the previous match; each character
 * skipped between two matches costs GAP. So a prefix beats a word start, which
 * beats a run in the middle, which beats a scattered subsequence. Equal scores
 * keep the earliest placement, so the result is the same on every run; callers
 * sort stably and so keep their own order between equal scores. An empty query
 * matches everything with score 0.
 */
const MATCH = 16;
const BOUNDARY = 8;
const CAMEL = 7;
const CONSECUTIVE = 8;
const GAP = 1;
const SEPARATORS = '/-_. ';

function bonusAt(text, index) {
  if (index === 0 || SEPARATORS.includes(text[index - 1])) return BOUNDARY;
  const previous = text[index - 1];
  const current = text[index];
  if (previous === previous.toLowerCase() && previous !== previous.toUpperCase()
    && current !== current.toLowerCase()) return CAMEL;
  return 0;
}

export function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return {match: true, score: 0, indices: []};
  // A quick in-order scan rejects most candidates before the full search.
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi < q.length) return {match: false, score: 0, indices: []};

  // score[i][j]: the best score placing q[0..i] with q[i] on t[j]; from[i][j]
  // is where q[i - 1] went in that placement.
  const score = q.split('').map(() => new Array(t.length).fill(-Infinity));
  const from = q.split('').map(() => new Array(t.length).fill(-1));
  for (let j = 0; j < t.length; j++) {
    if (t[j] === q[0]) score[0][j] = MATCH + bonusAt(text, j);
  }
  for (let i = 1; i < q.length; i++) {
    // The best earlier placement of q[i - 1], less GAP for each character since.
    let best = -Infinity;
    let bestAt = -1;
    for (let j = 1; j < t.length; j++) {
      best -= GAP;
      const previous = score[i - 1][j - 1];
      if (previous > best) {
        best = previous;
        bestAt = j - 1;
      }
      if (t[j] !== q[i] || bestAt === -1) continue;
      const adjacent = previous + CONSECUTIVE;
      const reach = adjacent >= best ? adjacent : best;
      score[i][j] = reach + MATCH + bonusAt(text, j);
      from[i][j] = adjacent >= best ? j - 1 : bestAt;
    }
  }

  const last = q.length - 1;
  let end = 0;
  for (let j = 1; j < t.length; j++) {
    if (score[last][j] > score[last][end]) end = j;
  }
  const indices = new Array(q.length);
  for (let i = last, j = end; i >= 0; j = from[i][j], i--) indices[i] = j;
  return {match: true, score: score[last][end], indices};
}
