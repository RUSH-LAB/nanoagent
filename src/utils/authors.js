/**
 * Author-list formatter shared by the Bibliography and Recommendations pages.
 *
 * Renders an author array as 'Unknown' when empty, the names joined by ', '
 * for up to three authors, or the first three names followed by ', et al.'
 * once there are more than three.
 *
 * Named distinctly from the divergent `formatAuthors` helpers elsewhere in the
 * codebase (CitationGraph, CitationAutocomplete, PaperRecommendations, and the
 * content-search page), which intentionally format author lists in other ways.
 *
 * @param {string[]} authors  List of author names.
 * @returns {string}  The formatted author list.
 */
export function formatAuthorList(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')}, et al.`;
}
