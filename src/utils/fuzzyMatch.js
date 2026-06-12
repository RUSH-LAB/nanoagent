/**
 * Fuzzy search scorer shared by the editor's FileSearchDialog and the
 * CommandPalette. Lowercases both arguments, then scores the query against a
 * candidate string: a substring starting at index 0 scores 2, a substring
 * elsewhere scores 1, and otherwise a subsequence scan decides whether every
 * query character appears in order (score 0).
 */
export function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return {match: true, score: t.indexOf(q) === 0 ? 2 : 1};
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return {match: qi === q.length, score: 0};
}
