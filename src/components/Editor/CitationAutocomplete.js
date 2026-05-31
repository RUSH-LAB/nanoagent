import React, {useState, useEffect, useRef, useCallback} from 'react';
import styles from './CitationAutocomplete.module.css';
import API_BASE from '@site/src/utils/api';
const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search';

/**
 * Generate a citation key from author name and year: "vaswani2017"
 */
function generateCiteKey(authorName, year) {
  const lastName = (authorName || 'unknown')
    .split(/\s+/)
    .pop()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return `${lastName}${year || ''}`;
}

/**
 * Format authors for display: "Smith et al." or "Smith & Jones"
 */
function formatAuthors(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  const first = authors[0].name || authors[0];
  if (authors.length === 1) return first;
  if (authors.length === 2) return `${first} & ${authors[1].name || authors[1]}`;
  return `${first} et al.`;
}

export default function CitationAutocomplete({editor, visible, onClose, cursorCoords}) {
  const [query, setQuery] = useState('');
  const [localRefs, setLocalRefs] = useState({});
  const [localResults, setLocalResults] = useState([]);
  const [remoteResults, setRemoteResults] = useState([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inserting, setInserting] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const debounceRef = useRef(null);

  // Load local references when dropdown opens
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setLocalResults([]);
    setRemoteResults([]);
    setSelectedIndex(0);

    fetch(`${API_BASE}/api/references`)
      .then(r => r.json())
      .then(data => {
        setLocalRefs(data.references || {});
      })
      .catch(() => setLocalRefs({}));
  }, [visible]);

  // Focus input when visible
  useEffect(() => {
    if (visible && inputRef.current) {
      // Small delay to ensure the DOM is ready
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  // Filter local references when query changes
  useEffect(() => {
    if (!query.trim()) {
      // Show all local refs when no query
      const all = Object.entries(localRefs).map(([key, ref]) => ({
        key,
        title: ref.title || key,
        authors: ref.author ? [ref.author] : [],
        year: ref.year,
        source: 'local',
      }));
      setLocalResults(all);
      setRemoteResults([]);
      return;
    }

    const q = query.toLowerCase();
    const filtered = Object.entries(localRefs)
      .filter(([key, ref]) => {
        const searchable = `${key} ${ref.title || ''} ${ref.author || ''} ${ref.year || ''}`.toLowerCase();
        return searchable.includes(q);
      })
      .map(([key, ref]) => ({
        key,
        title: ref.title || key,
        authors: ref.author ? [ref.author] : [],
        year: ref.year,
        source: 'local',
      }));
    setLocalResults(filtered);
  }, [query, localRefs]);

  // Search Semantic Scholar with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim() || query.trim().length < 3) {
      setRemoteResults([]);
      setRemoteLoading(false);
      return;
    }

    setRemoteLoading(true);
    debounceRef.current = setTimeout(() => {
      const url = `${S2_API}?query=${encodeURIComponent(query.trim())}&limit=5&fields=title,authors,year,venue,externalIds`;
      fetch(url)
        .then(r => r.json())
        .then(data => {
          const papers = (data.data || []).map(paper => {
            const authorList = paper.authors || [];
            const firstName = authorList.length > 0 ? authorList[0].name : 'unknown';
            const key = generateCiteKey(firstName, paper.year);
            return {
              key,
              title: paper.title || 'Untitled',
              authors: authorList,
              year: paper.year,
              venue: paper.venue,
              externalIds: paper.externalIds,
              paperId: paper.paperId,
              source: 'semantic_scholar',
            };
          });
          setRemoteResults(papers);
          setRemoteLoading(false);
        })
        .catch(() => {
          setRemoteResults([]);
          setRemoteLoading(false);
        });
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [localResults, remoteResults]);

  const allResults = [...localResults, ...remoteResults];

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-result-item]');
    if (items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({block: 'nearest'});
    }
  }, [selectedIndex]);

  const insertCitation = useCallback(async (result) => {
    if (!editor || inserting) return;
    setInserting(true);

    try {
      let citeKey = result.key;

      if (result.source === 'semantic_scholar') {
        // Add to references.yaml via POST /api/references
        const refData = {
          key: citeKey,
          title: result.title,
          author: formatAuthors(result.authors),
          year: result.year,
          venue: result.venue || '',
        };
        if (result.externalIds?.DOI) {
          refData.doi = result.externalIds.DOI;
        }
        if (result.externalIds?.ArXiv) {
          refData.arxiv = result.externalIds.ArXiv;
        }

        try {
          const res = await fetch(`${API_BASE}/api/references`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(refData),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.key) citeKey = data.key;
          }
        } catch {
          // If saving fails, still insert the citation
        }
      }

      // Insert [@key] at the cursor position
      editor.chain().focus().insertContent(`[@${citeKey}]`).run();
    } finally {
      setInserting(false);
      onClose();
    }
  }, [editor, inserting, onClose]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      editor?.commands.focus();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, allResults.length - 1));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (allResults[selectedIndex]) {
        insertCitation(allResults[selectedIndex]);
      }
      return;
    }
  }, [allResults, selectedIndex, insertCitation, onClose, editor]);

  if (!visible) return null;

  // Position the dropdown near the cursor
  const dropdownStyle = {};
  if (cursorCoords) {
    dropdownStyle.top = cursorCoords.bottom + 4;
    dropdownStyle.left = cursorCoords.left;
    // Prevent going off-screen right
    if (cursorCoords.left + 420 > window.innerWidth) {
      dropdownStyle.left = window.innerWidth - 430;
    }
    // Prevent going off-screen bottom
    if (cursorCoords.bottom + 344 > window.innerHeight) {
      dropdownStyle.top = cursorCoords.top - 344;
    }
  }

  return (
    <>
      <div className={styles.overlay} onClick={() => { onClose(); editor?.commands.focus(); }} />
      <div className={styles.dropdown} style={dropdownStyle}>
        <div className={styles.searchRow}>
          <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="text"
            placeholder="Search references or Semantic Scholar..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className={styles.resultsList} ref={listRef}>
          {localResults.length > 0 && (
            <>
              <div className={styles.sectionLabel}>Local References</div>
              {localResults.map((result, i) => (
                <button
                  key={`local-${result.key}`}
                  data-result-item
                  className={`${styles.resultItem} ${selectedIndex === i ? styles.resultItemActive : ''}`}
                  onClick={() => insertCitation(result)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <div className={styles.resultTitle}>
                    <span className={styles.resultKey}>@{result.key}</span>
                    {result.title}
                  </div>
                  <div className={styles.resultMeta}>
                    {formatAuthors(result.authors)}
                    {result.year ? ` (${result.year})` : ''}
                    {' '}
                    <span className={`${styles.resultSource} ${styles.sourceLocal}`}>local</span>
                  </div>
                </button>
              ))}
            </>
          )}

          {remoteResults.length > 0 && (
            <>
              <div className={styles.sectionLabel}>Semantic Scholar</div>
              {remoteResults.map((result, i) => {
                const globalIdx = localResults.length + i;
                return (
                  <button
                    key={`s2-${result.paperId || i}`}
                    data-result-item
                    className={`${styles.resultItem} ${selectedIndex === globalIdx ? styles.resultItemActive : ''}`}
                    onClick={() => insertCitation(result)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                  >
                    <div className={styles.resultTitle}>
                      <span className={styles.resultKey}>@{result.key}</span>
                      {result.title}
                    </div>
                    <div className={styles.resultMeta}>
                      {formatAuthors(result.authors)}
                      {result.year ? ` (${result.year})` : ''}
                      {result.venue ? ` - ${result.venue}` : ''}
                      {' '}
                      <span className={`${styles.resultSource} ${styles.sourceRemote}`}>S2</span>
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {remoteLoading && (
            <div className={styles.loading}>Searching Semantic Scholar...</div>
          )}

          {!remoteLoading && allResults.length === 0 && query.trim().length > 0 && (
            <div className={styles.emptyState}>
              {query.trim().length < 3
                ? 'Type at least 3 characters to search'
                : 'No references found'}
            </div>
          )}

          {!query.trim() && allResults.length === 0 && (
            <div className={styles.emptyState}>
              No local references. Type to search Semantic Scholar.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
