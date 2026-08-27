import React from 'react';
import Layout from '@theme/Layout';
import ErrorBoundary from '@site/src/components/ErrorBoundary';

const METHOD_COLORS = {
  GET: {bg: '#dbeafe', color: '#1e40af', border: '#93c5fd'},
  POST: {bg: '#dcfce7', color: '#166534', border: '#86efac'},
  PUT: {bg: '#fef3c7', color: '#92400e', border: '#fcd34d'},
  DELETE: {bg: '#fee2e2', color: '#991b1b', border: '#fca5a5'},
  PATCH: {bg: '#f3e8ff', color: '#6b21a8', border: '#d8b4fe'},
};

function MethodBadge({method}) {
  const colors = METHOD_COLORS[method] || METHOD_COLORS.GET;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '0.7rem',
      fontWeight: 700,
      fontFamily: 'monospace',
      letterSpacing: '0.5px',
      background: colors.bg,
      color: colors.color,
      border: `1px solid ${colors.border}`,
      minWidth: '52px',
      textAlign: 'center',
    }}>
      {method}
    </span>
  );
}

function EndpointRow({method, path, description, request, response}) {
  const [expanded, setExpanded] = React.useState(false);
  const hasDetails = request || response;

  return (
    <tr style={{borderBottom: '1px solid var(--ifm-table-border-color, #e5e7eb)'}}>
      <td style={{padding: '10px 12px', verticalAlign: 'top', whiteSpace: 'nowrap'}}>
        <MethodBadge method={method} />
      </td>
      <td style={{padding: '10px 12px', verticalAlign: 'top'}}>
        <code style={{fontSize: '0.85rem', background: 'var(--ifm-code-background, #f5f5f5)', padding: '2px 6px', borderRadius: '3px'}}>
          {path}
        </code>
      </td>
      <td style={{padding: '10px 12px', verticalAlign: 'top'}}>
        <div>{description}</div>
        {hasDetails && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--ifm-color-primary)',
              cursor: 'pointer',
              padding: '2px 0',
              fontSize: '0.8rem',
              marginTop: '4px',
            }}
          >
            {expanded ? 'Hide details ▲' : 'Show details ▼'}
          </button>
        )}
        {expanded && (
          <div style={{marginTop: '8px', fontSize: '0.83rem', lineHeight: '1.5'}}>
            {request && (
              <div style={{marginBottom: '8px'}}>
                <strong style={{fontSize: '0.75rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.5px'}}>Request</strong>
                <pre style={{
                  background: 'var(--ifm-code-background, #f5f5f5)',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  fontSize: '0.8rem',
                  marginTop: '4px',
                  overflow: 'auto',
                  border: '1px solid var(--ifm-table-border-color, #e5e7eb)',
                }}>
                  {request}
                </pre>
              </div>
            )}
            {response && (
              <div>
                <strong style={{fontSize: '0.75rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.5px'}}>Response</strong>
                <pre style={{
                  background: 'var(--ifm-code-background, #f5f5f5)',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  fontSize: '0.8rem',
                  marginTop: '4px',
                  overflow: 'auto',
                  border: '1px solid var(--ifm-table-border-color, #e5e7eb)',
                }}>
                  {response}
                </pre>
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function EndpointTable({endpoints}) {
  return (
    <table style={{
      width: '100%',
      borderCollapse: 'collapse',
      marginBottom: '2rem',
      fontSize: '0.9rem',
    }}>
      <thead>
        <tr style={{borderBottom: '2px solid var(--ifm-table-border-color, #d1d5db)'}}>
          <th style={{padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.5px'}}>Method</th>
          <th style={{padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.5px'}}>Path</th>
          <th style={{padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', color: '#6b7280', letterSpacing: '0.5px'}}>Description</th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map((ep, i) => (
          <EndpointRow key={i} {...ep} />
        ))}
      </tbody>
    </table>
  );
}

function CategorySection({id, title, icon, description, endpoints}) {
  return (
    <section id={id} style={{marginBottom: '3rem'}}>
      <h2 style={{
        borderBottom: '2px solid var(--ifm-color-primary)',
        paddingBottom: '8px',
        marginBottom: '8px',
        fontSize: '1.4rem',
      }}>
        {icon} {title}
      </h2>
      {description && (
        <p style={{color: '#6b7280', marginBottom: '16px', fontSize: '0.9rem'}}>{description}</p>
      )}
      <EndpointTable endpoints={endpoints} />
    </section>
  );
}

const CATEGORIES = [
  {
    id: 'files',
    title: 'Files',
    icon: '📄',
    description: 'CRUD operations for markdown/MDX content files under the content/ directory.',
    endpoints: [
      {
        method: 'GET', path: '/api/files', description: 'List file tree. Returns nested directory structure under content/.',
        request: 'Query: ?dir=content (optional, defaults to "content")',
        response: '{ "files": [{ "name": "intro.md", "path": "content/intro.md", "type": "file" }, { "name": "docs", "path": "content/docs", "type": "directory", "children": [...] }] }',
      },
      {
        method: 'GET', path: '/api/file', description: 'Read a single file\'s content.',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "content": "---\\ntitle: ...\\n---\\n\\n# Example\\n..." }',
      },
      {
        method: 'POST', path: '/api/file', description: 'Create a new file. Fails if file already exists.',
        request: '{ "path": "content/docs/new-page.md", "content": "---\\ntitle: New Page\\n---\\n" }',
        response: '{ "success": true, "path": "content/docs/new-page.md" }',
      },
      {
        method: 'PUT', path: '/api/file', description: 'Update an existing file\'s content. Fails if file does not exist.',
        request: '{ "path": "content/docs/example.md", "content": "updated content..." }',
        response: '{ "success": true }',
      },
      {
        method: 'DELETE', path: '/api/file', description: 'Soft-delete a file by moving it to the .trash/ directory with a timestamp prefix.',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "success": true, "trashPath": ".trash/content/docs/2025-01-15T10-30-00-000Z_example.md" }',
      },
      {
        method: 'POST', path: '/api/file/rename', description: 'Rename or move a file to a new path.',
        request: '{ "oldPath": "content/docs/old-name.md", "newPath": "content/docs/new-name.md" }',
        response: '{ "success": true, "path": "content/docs/new-name.md" }',
      },
      {
        method: 'POST', path: '/api/file/move', description: 'Move a file to a different directory, keeping its filename.',
        request: '{ "filePath": "content/docs/example.md", "targetDir": "content/posts" }',
        response: '{ "success": true, "newPath": "content/posts/example.md" }',
      },
      {
        method: 'GET', path: '/api/files/search', description: 'Search files by name or path.',
        request: 'Query: ?q=algebra',
        response: '{ "files": [{ "name": "algebra.md", "path": "content/docs/math/algebra.md" }] }',
      },
      {
        method: 'GET', path: '/api/file/info', description: 'Get file metadata: size, word count, modification time, draft status.',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "path": "content/docs/example.md", "size": 1234, "mtime": "2025-01-15T10:30:00.000Z", "wordCount": 250, "hasFrontmatter": true, "draft": false }',
      },
      {
        method: 'POST', path: '/api/file/draft', description: 'Toggle the draft status in a file\'s YAML frontmatter.',
        request: '{ "path": "content/docs/example.md", "draft": true }',
        response: '{ "success": true }',
      },
      {
        method: 'GET', path: '/api/file/export', description: 'Export a file as raw Markdown or converted HTML for download.',
        request: 'Query: ?path=content/docs/example.md&format=md  (format: "md" or "html")',
        response: 'File download (Content-Disposition: attachment)',
      },
      {
        method: 'GET', path: '/api/file/compare', description: 'Compare a file\'s content at two git commits (or one commit vs current working copy).',
        request: 'Query: ?path=content/docs/example.md&hash1=abc1234&hash2=def5678  (hash2 can be "current")',
        response: '{ "version1": { "hash": "abc1234", "content": "...", "date": "2025-01-10" }, "version2": { "hash": "def5678", "content": "...", "date": "2025-01-15" } }',
      },
      {
        method: 'POST', path: '/api/upload', description: 'Upload an image file (PNG, JPG, GIF, SVG, WebP). Sends raw binary body.',
        request: 'Query: ?name=photo.png&dir=static/img/uploads (dir optional)\nBody: raw image bytes',
        response: '{ "success": true, "url": "/img/uploads/photo.png" }',
      },
      {
        method: 'POST', path: '/api/folder', description: 'Create a new directory under content/.',
        request: '{ "path": "content/docs/new-section" }',
        response: '{ "success": true, "path": "content/docs/new-section" }',
      },
      {
        method: 'DELETE', path: '/api/folder', description: 'Delete an empty directory. Fails if the directory contains files.',
        request: '{ "path": "content/docs/empty-section" }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'trash',
    title: 'Trash',
    icon: '🗑️',
    description: 'Manage soft-deleted files in the .trash/ directory.',
    endpoints: [
      {
        method: 'GET', path: '/api/trash', description: 'List all trashed files, sorted newest first.',
        response: '{ "files": [{ "trashPath": ".trash/content/docs/...", "originalPath": "content/docs/example.md", "originalName": "example.md", "deletedAt": "2025-01-15T10:30:00.000Z" }] }',
      },
      {
        method: 'POST', path: '/api/trash/restore', description: 'Restore a trashed file to its original location. Fails if a file already exists there.',
        request: '{ "trashPath": ".trash/content/docs/2025-01-15T10-30-00-000Z_example.md" }',
        response: '{ "success": true, "restoredPath": "content/docs/example.md" }',
      },
      {
        method: 'DELETE', path: '/api/trash/empty', description: 'Permanently delete all trashed files.',
        response: '{ "success": true, "deleted": 5 }',
      },
    ],
  },
  {
    id: 'comments',
    title: 'Comments',
    icon: '💬',
    description: 'Per-page comments with threading support.',
    endpoints: [
      {
        method: 'GET', path: '/api/comments', description: 'List comments for a specific page.',
        request: 'Query: ?page=/docs/example',
        response: '{ "comments": [{ "id": "c_1705312200000_abc123", "author": "Alice", "text": "Great article!", "parentId": null, "createdAt": "2025-01-15T10:30:00.000Z" }] }',
      },
      {
        method: 'POST', path: '/api/comments', description: 'Create a new comment. Rate-limited to 30 requests/minute per IP.',
        request: '{ "page": "/docs/example", "author": "Alice", "text": "Great article!", "parentId": null }',
        response: '{ "comment": { "id": "c_...", "author": "Alice", "text": "Great article!", "parentId": null, "createdAt": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/comments', description: 'Delete a comment by ID.',
        request: '{ "page": "/docs/example", "commentId": "c_1705312200000_abc123" }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'discussions',
    title: 'Discussions',
    icon: '🗣️',
    description: 'Channel-based discussions with real-time messaging.',
    endpoints: [
      {
        method: 'GET', path: '/api/discussions', description: 'List all discussion channels with message counts.',
        response: '{ "channels": [{ "id": "general", "name": "General", "topic": "...", "linkedPage": null, "createdAt": "...", "messageCount": 12 }] }',
      },
      {
        method: 'POST', path: '/api/discussions', description: 'Create a new discussion channel.',
        request: '{ "name": "Research Ideas", "topic": "Brainstorming session", "linkedPage": "/docs/research" }',
        response: '{ "channel": { "id": "research-ideas", "name": "Research Ideas", "topic": "...", "linkedPage": "...", "createdAt": "...", "messageCount": 0 } }',
      },
      {
        method: 'GET', path: '/api/discussions/:id/messages', description: 'Get all messages in a channel.',
        request: 'URL param: :id = channel ID (e.g., "general")',
        response: '{ "messages": [{ "id": "msg_...", "author": "Alice", "text": "Hello!", "createdAt": "..." }] }',
      },
      {
        method: 'POST', path: '/api/discussions/:id/messages', description: 'Post a message to a channel. Rate-limited to 30/min per IP.',
        request: 'URL param: :id = channel ID\n{ "author": "Alice", "text": "Hello everyone!" }',
        response: '{ "message": { "id": "msg_...", "author": "Alice", "text": "Hello everyone!", "createdAt": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/discussions/:id', description: 'Delete a channel and all its messages.',
        request: 'URL param: :id = channel ID',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'references',
    title: 'References & Bibliography',
    icon: '📚',
    description: 'Manage the references.yaml bibliography, enrich entries from academic APIs, track preprints, and import/export BibTeX.',
    endpoints: [
      {
        method: 'GET', path: '/api/references', description: 'Get all references from references.yaml.',
        response: '{ "references": { "vaswani2017": { "type": "article", "title": "Attention Is All You Need", "author": [...], "year": 2017, "venue": "NeurIPS" }, ... } }',
      },
      {
        method: 'POST', path: '/api/references', description: 'Add a new reference entry. Fails if the key already exists.',
        request: '{ "key": "smith2024", "entry": { "type": "article", "title": "...", "author": ["John Smith"], "year": 2024 } }',
        response: '{ "success": true }',
      },
      {
        method: 'GET', path: '/api/references/enrich', description: 'Fetch metadata for a reference from Semantic Scholar, CrossRef, and DBLP.',
        request: 'Query: ?key=vaswani2017',
        response: '{ "key": "vaswani2017", "current": { ... }, "sources": { "semanticScholar": { "title": "...", "citationCount": 90000, ... }, "crossref": { ... }, "dblp": { ... } } }',
      },
      {
        method: 'POST', path: '/api/references/enrich', description: 'Apply enriched metadata fields to a reference in references.yaml.',
        request: '{ "key": "vaswani2017", "fields": { "doi": "10.5555/...", "citationCount": 90000 } }',
        response: '{ "success": true, "entry": { ... } }',
      },
      {
        method: 'GET', path: '/api/references/track', description: 'Check if an arXiv preprint has been published to a venue via Semantic Scholar.',
        request: 'Query: ?key=smith2024',
        response: '{ "published": true, "venue": "NeurIPS 2024", "doi": "10.5555/...", "journal": null, "year": 2024, "currentVenue": "arXiv", "tracked": true, "publishedVenue": "NeurIPS 2024" }',
      },
      {
        method: 'POST', path: '/api/references/track', description: 'Update a reference\'s tracking status and apply published venue info if available.',
        request: '{ "key": "smith2024" }',
        response: '{ "success": true, "published": true, "venue": "NeurIPS 2024", "tracked": true, "publishedVenue": "NeurIPS 2024" }',
      },
      {
        method: 'POST', path: '/api/references/track-all', description: 'Batch-check all arXiv references for publication status. Rate-limited to 2/min. Checks one reference per second.',
        response: '{ "checked": 15, "updated": 3, "results": [{ "key": "smith2024", "published": true, "venue": "NeurIPS 2024" }, ...] }',
      },
      {
        method: 'POST', path: '/api/references/import-bibtex', description: 'Parse a BibTeX string and import entries into references.yaml. Skips duplicate keys. Rate-limited to 5/min.',
        request: '{ "bibtex": "@article{smith2024,\\n  title = {Example},\\n  author = {John Smith},\\n  year = {2024}\\n}" }',
        response: '{ "added": 3, "skipped": 1, "errors": [] }',
      },
      {
        method: 'GET', path: '/api/references/export', description: 'Export all references as a downloadable BibTeX (.bib) file.',
        response: 'File download: references.bib (Content-Type: text/plain)',
      },
      {
        method: 'GET', path: '/api/metadata/search', description: 'Search Semantic Scholar and CrossRef for paper metadata by query string.',
        request: 'Query: ?q=attention+is+all+you+need',
        response: '{ "results": [{ "source": "semanticscholar", "title": "...", "authors": [...], "year": 2017, "doi": "...", "url": "..." }, ...] }',
      },
    ],
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    icon: '💡',
    description: 'AI-powered paper recommendations based on your bibliography, using Semantic Scholar\'s citation graph.',
    endpoints: [
      {
        method: 'GET', path: '/api/recommendations', description: 'Get paper recommendations based on your top bibliography entries. Queries Semantic Scholar for related papers. Rate-limited to 10/min.',
        response: '{ "recommendations": [{ "title": "...", "authors": [...], "year": 2024, "venue": "ICML", "arxivId": "2401.12345", "score": 3, "recommendedBy": ["Paper A", "Paper B", "Paper C"] }] }',
      },
      {
        method: 'POST', path: '/api/recommendations/add', description: 'Add a recommended paper to your bibliography. Auto-generates citation key from first author\'s last name + year.',
        request: '{ "title": "Example Paper", "authors": ["John Smith"], "year": 2024, "venue": "ICML", "arxivId": "2401.12345" }',
        response: '{ "key": "smith2024", "success": true }',
      },
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics',
    icon: '📊',
    description: 'Simple pageview tracking and retrieval.',
    endpoints: [
      {
        method: 'POST', path: '/api/analytics/pageview', description: 'Record a pageview. Stores per-path counts and keeps the last 100 recent visits.',
        request: '{ "path": "/docs/example", "referrer": "https://google.com", "userAgent": "Mozilla/5.0..." }',
        response: '{ "success": true }',
      },
      {
        method: 'GET', path: '/api/analytics', description: 'Get all analytics data: per-page view counts and recent pageviews.',
        response: '{ "pageviews": { "/docs/example": 42, "/": 150 }, "recent": [{ "path": "/docs/example", "referrer": "...", "userAgent": "...", "timestamp": "..." }] }',
      },
    ],
  },
  {
    id: 'users',
    title: 'Users & Presence',
    icon: '👥',
    description: 'User management with role-based access control (owner/editor/viewer) and real-time editing presence.',
    endpoints: [
      {
        method: 'GET', path: '/api/users', description: 'List all users and their roles.',
        response: '{ "users": { "user_abc123": { "role": "owner", "email": "alice@example.com", "name": "Alice", "addedAt": "..." } } }',
      },
      {
        method: 'GET', path: '/api/users/me', description: 'Get the current user\'s role. Returns "viewer" for unknown users.',
        request: 'Query: ?userId=user_abc123',
        response: '{ "role": "owner", "email": "alice@example.com", "name": "Alice" }',
      },
      {
        method: 'PUT', path: '/api/users/:id/role', description: 'Set a user\'s role. Only owners can change roles.',
        request: '{ "role": "editor", "email": "bob@example.com", "name": "Bob", "requesterId": "user_abc123" }',
        response: '{ "success": true, "user": { "role": "editor", "email": "bob@example.com", "name": "Bob", "addedAt": "..." } }',
      },
      {
        method: 'POST', path: '/api/presence', description: 'Update the current user\'s editing presence for a file (heartbeat).',
        request: '{ "filePath": "content/docs/example.md", "userId": "user_abc123", "userName": "Alice", "cursor": { "line": 10, "ch": 5 } }',
        response: '{ "success": true }',
      },
      {
        method: 'GET', path: '/api/presence', description: 'List users currently editing a specific file.',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "users": [{ "userId": "user_abc123", "userName": "Alice", "cursor": { "line": 10, "ch": 5 }, "lastSeen": 1705312200000 }] }',
      },
    ],
  },
  {
    id: 'ai',
    title: 'AI',
    icon: '🤖',
    description: 'AI writing assistant powered by Claude (requires ANTHROPIC_API_KEY environment variable).',
    endpoints: [
      {
        method: 'POST', path: '/api/ai/complete', description: 'Generate AI text completions. Supports continue, improve, explain, and summarize modes. Rate-limited to 10/min per IP.',
        request: '{ "prompt": "The transformer architecture...", "context": "Optional surrounding text", "type": "continue" }\n\nValid types: "continue", "improve", "explain", "summarize"',
        response: '{ "text": "...generated continuation..." }',
      },
    ],
  },
  {
    id: 'misc',
    title: 'Miscellaneous',
    icon: '🔧',
    description: 'Health checks, search, history, backlinks, graph, templates, notifications, and content statistics.',
    endpoints: [
      {
        method: 'GET', path: '/api/health', description: 'Server health check. Returns uptime and memory usage.',
        response: '{ "status": "ok", "uptime": 12345.678, "memory": 52428800 }',
      },
      {
        method: 'GET', path: '/api/stats', description: 'Content statistics: total files, total words, reference count, broken down by directory. Cached for 30 seconds.',
        response: '{ "totalFiles": 42, "totalWords": 125000, "references": 150, "byDirectory": { "docs": { "files": 20, "words": 80000 }, "posts": { "files": 22, "words": 45000 } } }',
      },
      {
        method: 'GET', path: '/api/search', description: 'Full-text search across all content files. Returns up to 50 results with context snippets.',
        request: 'Query: ?q=transformer',
        response: '{ "results": [{ "path": "content/docs/attention.md", "name": "attention.md", "snippet": "...the transformer architecture..." }] }',
      },
      {
        method: 'GET', path: '/api/history', description: 'Get git commit history for a file (last 20 commits).',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "commits": [{ "hash": "abc1234", "author": "Alice", "date": "2025-01-15 10:30:00 -0500", "message": "Update example" }] }',
      },
      {
        method: 'GET', path: '/api/history/diff', description: 'Get the git diff for a specific commit on a file.',
        request: 'Query: ?path=content/docs/example.md&hash=abc1234',
        response: '{ "diff": "--- a/content/docs/example.md\\n+++ b/content/docs/example.md\\n@@ -1,3 +1,4 @@..." }',
      },
      {
        method: 'GET', path: '/api/notes', description: 'Get scratch-pad notes. Optionally filter by key.',
        request: 'Query: ?key=my-note (optional)',
        response: '{ "notes": { "my-note": { "content": "...", "title": "My Note", "updatedAt": "..." } } }\nor with key: { "note": { "content": "...", "title": "...", "updatedAt": "..." } }',
      },
      {
        method: 'PUT', path: '/api/notes', description: 'Create or update a scratch-pad note.',
        request: '{ "key": "my-note", "content": "Some scratchpad text...", "title": "My Note" }',
        response: '{ "success": true }',
      },
      {
        method: 'GET', path: '/api/backlinks', description: 'Find all pages that link to a given page via wiki-links ([[page]]) or citation references ([@key]).',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "backlinks": [{ "sourcePath": "content/docs/intro.md", "sourceTitle": "Introduction", "linkType": "wikilink" }] }',
      },
      {
        method: 'GET', path: '/api/graph', description: 'Build a link graph of all wiki-link connections between pages. Returns nodes and edges for visualization.',
        response: '{ "nodes": [{ "id": "docs/example", "path": "docs/example.md", "title": "Example", "category": "docs" }], "edges": [{ "source": "docs/intro", "target": "docs/example" }] }',
      },
      {
        method: 'GET', path: '/api/templates', description: 'List available page templates (blank, blog, research, math, tutorial).',
        response: '{ "templates": [{ "id": "blank", "name": "Blank Page", "content": "---\\ntitle: \\"Untitled\\"\\n..." }, ...] }',
      },
      {
        method: 'GET', path: '/api/notifications/counts', description: 'Get counts of new comments and discussion messages since a given timestamp.',
        request: 'Query: ?since=2025-01-15T00:00:00.000Z',
        response: '{ "comments": 5, "discussions": 12 }',
      },
      {
        method: 'GET', path: '/api/perf', description: 'Server performance metrics: average, max, and p95 response times per endpoint.',
        response: '{ "endpoints": [{ "path": "/api/search", "avgMs": 12.5, "maxMs": 45, "count": 200, "p95Ms": 30 }, ...] }',
      },
      {
        method: 'GET', path: '/api/calendar', description: 'Content calendar: all pages grouped by month with word counts, draft status, and scheduled publications. Cached for 60 seconds.',
        response: '{ "months": [{ "month": "2025-01", "files": [{ "path": "content/docs/intro.md", "title": "Introduction", "date": "2025-01-15", "wordCount": 500, "draft": false }] }] }',
      },
      {
        method: 'GET', path: '/api/integrity', description: 'Data integrity validation: checks JSON file validity, YAML validity, orphaned snapshots, and orphaned comments.',
        response: '{ "status": "healthy", "checks": [{ "name": "json_validity", "passed": true, "details": "All 8 JSON files are valid" }, { "name": "yaml_validity", "passed": true, "details": "references.yaml is valid YAML" }, ...] }',
      },
      {
        method: 'GET', path: '/api/suggest', description: 'Get contextual suggestions for references and wiki-link targets based on text being typed.',
        request: 'Query: ?text=transformer+attention&limit=5',
        response: '{ "references": [{ "key": "vaswani2017", "title": "Attention Is All You Need", "relevance": 3 }], "pages": [{ "path": "content/docs/attention.md", "title": "Attention Mechanisms", "relevance": 2 }] }',
      },
    ],
  },
  {
    id: 'bookmarks',
    title: 'Bookmarks',
    icon: '\u{1F516}',
    endpoints: [
      {
        method: 'GET', path: '/api/bookmarks', description: 'List all bookmarks.',
        response: '{ "bookmarks": [{ "path": "/docs/intro", "title": "Introduction", "addedAt": "2025-..." }] }',
      },
      {
        method: 'POST', path: '/api/bookmarks', description: 'Add a bookmark.',
        request: '{ "path": "/docs/intro", "title": "Introduction" }',
        response: '{ "success": true, "bookmark": { "path": "...", "title": "...", "addedAt": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/bookmarks', description: 'Remove a bookmark.',
        request: '{ "path": "/docs/intro" }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'reading-lists',
    title: 'Reading Lists',
    icon: '\u{1F4DA}',
    endpoints: [
      {
        method: 'GET', path: '/api/reading-lists', description: 'List all reading lists.',
        response: '{ "lists": [{ "id": "uuid", "name": "...", "description": "...", "items": [...], "createdAt": "...", "updatedAt": "..." }] }',
      },
      {
        method: 'POST', path: '/api/reading-lists', description: 'Create a new reading list.',
        request: '{ "name": "ML Papers", "description": "Optional description" }',
        response: '{ "success": true, "list": { "id": "uuid", ... } }',
      },
      {
        method: 'DELETE', path: '/api/reading-lists/:id', description: 'Delete a reading list.',
        response: '{ "success": true }',
      },
      {
        method: 'POST', path: '/api/reading-lists/:id/items', description: 'Add an item to a reading list.',
        request: '{ "path": "content/docs/paper.md", "title": "Paper Title", "type": "doc" }',
        response: '{ "success": true, "list": { ... } }',
      },
      {
        method: 'DELETE', path: '/api/reading-lists/:id/items', description: 'Remove an item from a reading list.',
        request: '{ "path": "content/docs/paper.md" }',
        response: '{ "success": true, "list": { ... } }',
      },
      {
        method: 'PATCH', path: '/api/reading-lists/:id/items', description: 'Reorder an item within a reading list.',
        request: '{ "path": "content/docs/paper.md", "direction": "up" }',
        response: '{ "success": true, "list": { ... } }',
      },
    ],
  },
  {
    id: 'streaks',
    title: 'Writing Streaks',
    icon: '\u{1F525}',
    endpoints: [
      {
        method: 'GET', path: '/api/streak', description: 'Get writing streak data for a user.',
        request: 'Query: ?userId=default',
        response: '{ "currentStreak": 5, "longestStreak": 12, "totalWords": 8500, "dailyLog": [{ "date": "2025-01-15", "words": 350 }, ...] }',
      },
      {
        method: 'POST', path: '/api/streak', description: 'Record words written today.',
        request: '{ "userId": "default", "wordsWritten": 350 }',
        response: '{ "success": true, "date": "2025-01-15", "words": 350 }',
      },
    ],
  },
  {
    id: 'annotations',
    title: 'Annotations',
    icon: '\u{1F4DD}',
    endpoints: [
      {
        method: 'GET', path: '/api/annotations', description: 'List annotations for a page.',
        request: 'Query: ?page=/docs/intro',
        response: '{ "annotations": [{ "id": "ann_...", "text": "selected text", "note": "my note", "startOffset": 10, "endOffset": 25, "author": "...", "createdAt": "..." }] }',
      },
      {
        method: 'POST', path: '/api/annotations', description: 'Create an annotation (highlight + optional note).',
        request: '{ "page": "/docs/intro", "text": "selected text", "note": "my note", "startOffset": 10, "endOffset": 25, "author": "User" }',
        response: '{ "annotation": { "id": "ann_...", ... } }',
      },
      {
        method: 'DELETE', path: '/api/annotations', description: 'Delete an annotation.',
        request: '{ "page": "/docs/intro", "id": "ann_..." }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'reactions',
    title: 'Comment Reactions',
    icon: '\u{1F44D}',
    endpoints: [
      {
        method: 'POST', path: '/api/comments/react', description: 'Add a reaction to a comment. Valid emojis: thumbsup, heart, laugh, thinking, celebrate.',
        request: '{ "page": "/docs/intro", "commentId": "c_...", "emoji": "thumbsup", "userId": "user1" }',
        response: '{ "success": true, "reactions": [{ "emoji": "thumbsup", "userId": "user1" }] }',
      },
      {
        method: 'DELETE', path: '/api/comments/react', description: 'Remove a reaction from a comment.',
        request: '{ "page": "/docs/intro", "commentId": "c_...", "emoji": "thumbsup", "userId": "user1" }',
        response: '{ "success": true, "reactions": [] }',
      },
    ],
  },
  {
    id: 'bulk-ops',
    title: 'Bulk Operations',
    icon: '\u{1F4E6}',
    endpoints: [
      {
        method: 'POST', path: '/api/files/bulk', description: 'Bulk delete or move files. Action must be "delete" or "move".',
        request: '{ "action": "move", "paths": ["content/docs/a.md", "content/docs/b.md"], "targetDir": "content/archive" }',
        response: '{ "success": true, "processed": 2, "errors": [] }',
      },
      {
        method: 'GET', path: '/api/files/recent', description: 'List recently modified files.',
        request: 'Query: ?limit=10 (max 50)',
        response: '{ "files": [{ "name": "intro.md", "path": "content/docs/intro.md", "mtime": 1705123456000 }] }',
      },
      {
        method: 'GET', path: '/api/analytics/topics', description: 'Extract top 50 content keywords/topics from all markdown files.',
        response: '{ "topics": [{ "word": "transformer", "count": 42 }, ...] }',
      },
    ],
  },
  {
    id: 'discussion-pins',
    title: 'Discussion Pins',
    icon: '\u{1F4CC}',
    endpoints: [
      {
        method: 'POST', path: '/api/discussions/:id/pin', description: 'Pin a message in a channel.',
        request: '{ "messageId": "msg_..." }',
        response: '{ "success": true }',
      },
      {
        method: 'DELETE', path: '/api/discussions/:id/pin', description: 'Unpin a message from a channel.',
        request: '{ "messageId": "msg_..." }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'content-analysis',
    title: 'Content Analysis',
    icon: '\u{1F4CA}',
    endpoints: [
      {
        method: 'GET', path: '/api/file/keywords', description: 'Extract top 20 keywords from a file.',
        request: 'Query: ?path=content/docs/intro.md',
        response: '{ "keywords": [{ "word": "transformer", "count": 12 }], "totalWords": 500 }',
      },
      {
        method: 'GET', path: '/api/file/readability', description: 'Get readability metrics for a file (Flesch-Kincaid grade, reading time, etc.).',
        request: 'Query: ?path=content/docs/intro.md',
        response: '{ "wordCount": 500, "sentenceCount": 25, "avgWordsPerSentence": 20, "fleschKincaidGrade": 12.5, "readingLevel": "Advanced", "readingTimeMinutes": 3 }',
      },
      {
        method: 'GET', path: '/api/file/related', description: 'Get pages related to a file by shared tags and content similarity.',
        request: 'Query: ?path=content/docs/intro.md',
        response: '{ "related": [{ "path": "content/docs/overview.md", "title": "Overview", "score": 7.5 }] }',
      },
      {
        method: 'GET', path: '/api/file/lint', description: 'Lint a markdown file for common issues (missing title, empty headings, unclosed code blocks).',
        request: 'Query: ?path=content/docs/intro.md',
        response: '{ "issues": [{ "line": 5, "severity": "warning", "message": "Empty heading" }], "issueCount": 1 }',
      },
      {
        method: 'GET', path: '/api/content-health', description: 'Overall content health: broken links, orphan pages, drafts.',
        response: '{ "totalPages": 161, "draftCount": 2, "brokenLinkCount": 3, "orphanPageCount": 50, "totalLinks": 200, "brokenLinks": [...], "orphanPages": [...] }',
      },
      {
        method: 'GET', path: '/api/content-lint', description: 'Lint all content files and return a summary of issues.',
        response: '{ "files": [{ "path": "...", "issues": [...] }], "totalIssues": 64, "severityCounts": { "error": 0, "warning": 64, "info": 0 } }',
      },
      {
        method: 'GET', path: '/api/content-duplicates', description: 'Detect files with duplicate titles.',
        response: '{ "duplicates": [{ "title": "Introduction", "files": ["path1", "path2"] }], "count": 11 }',
      },
      {
        method: 'GET', path: '/api/tags', description: 'List all tags from content frontmatter with counts.',
        response: '{ "tags": [{ "tag": "machine-learning", "count": 5 }] }',
      },
      {
        method: 'GET', path: '/api/stats/timeline', description: 'Content creation timeline grouped by month.',
        response: '{ "timeline": [{ "month": "2025-01", "count": 10 }] }',
      },
      {
        method: 'GET', path: '/api/references/network', description: 'Citation network analysis: most cited papers, co-citations, uncited references.',
        response: '{ "totalReferences": 844, "citedReferences": 668, "uncitedReferences": 176, "mostCited": [...], "coCitations": [...] }',
      },
      {
        method: 'GET', path: '/api/file/quality', description: 'Compute a 0-100 quality score for a file based on word count, frontmatter, headings, citations, media, and readability.',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "path": "content/docs/example.md", "score": 72, "level": "good", "breakdown": { "words": { "score": 20, "max": 25, "wordCount": 650 }, "structure": { "score": 30, "max": 35 }, "citations": { "score": 6, "max": 10, "count": 3 }, "media": { "score": 8, "max": 10 }, "readability": { "score": 8, "max": 10 } }, "suggestions": ["Add citations [@key] to reference sources"] }',
      },
    ],
  },
  {
    id: 'message-mgmt',
    title: 'Message Management',
    icon: '\u{1F4AC}',
    endpoints: [
      {
        method: 'DELETE', path: '/api/discussions/:id/messages', description: 'Delete a message from a channel.',
        request: '{ "messageId": "msg_..." }',
        response: '{ "success": true }',
      },
      {
        method: 'PATCH', path: '/api/discussions/:id/messages', description: 'Edit a message in a channel.',
        request: '{ "messageId": "msg_...", "text": "Updated text" }',
        response: '{ "success": true, "message": { "id": "msg_...", "text": "Updated text", "editedAt": "..." } }',
      },
      {
        method: 'GET', path: '/api/discussions/:id/messages/search', description: 'Search messages within a channel.',
        request: 'Query: ?q=search+term',
        response: '{ "results": [{ "id": "msg_...", "author": "...", "text": "...", "createdAt": "..." }], "total": 2 }',
      },
      {
        method: 'DELETE', path: '/api/notes', description: 'Delete a note by key.',
        request: '{ "key": "note-key" }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'flashcards',
    title: 'Flashcards',
    icon: '\u{1F0CF}',
    description: 'Spaced-repetition flashcards with SM-2 scheduling. Supports per-user card decks, tags, and review quality tracking.',
    endpoints: [
      {
        method: 'POST', path: '/api/flashcards', description: 'Create a new flashcard. Rate-limited to 30/min per IP.',
        request: '{ "front": "What is attention?", "back": "A mechanism for weighting input relevance.", "tags": ["ml", "transformers"], "sourcePath": "content/docs/attention.md", "userId": "default" }',
        response: '{ "success": true, "card": { "id": "fc_...", "front": "...", "back": "...", "tags": [...], "sourcePath": "...", "interval": 1, "easeFactor": 2.5, "repetitions": 0, "nextReview": "2025-01-15", "createdAt": "..." } }',
      },
      {
        method: 'GET', path: '/api/flashcards', description: 'List all flashcards for a user.',
        request: 'Query: ?userId=default',
        response: '{ "cards": [{ "id": "fc_...", "front": "...", "back": "...", "tags": [...], "interval": 1, "nextReview": "2025-01-15", ... }], "total": 42 }',
      },
      {
        method: 'GET', path: '/api/flashcards/due', description: 'Get flashcards due for review today (nextReview <= today).',
        request: 'Query: ?userId=default',
        response: '{ "cards": [...], "dueCount": 5 }',
      },
      {
        method: 'GET', path: '/api/flashcards/review', description: 'Get flashcards due for review, sorted by next review date (oldest first).',
        request: 'Query: ?userId=default',
        response: '{ "cards": [...], "count": 5 }',
      },
      {
        method: 'POST', path: '/api/flashcards/review', description: 'Submit a review for a flashcard. Quality 0-5 (SM-2 algorithm). Rate-limited to 120/min per IP.',
        request: '{ "userId": "default", "cardId": "fc_...", "quality": 4 }',
        response: '{ "success": true, "card": { "id": "fc_...", "interval": 6, "easeFactor": 2.5, "repetitions": 2, "nextReview": "2025-01-21", "lastReviewed": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/flashcards', description: 'Delete a flashcard by ID.',
        request: '{ "userId": "default", "cardId": "fc_..." }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    icon: '\u{1F4D6}',
    description: 'Concept glossary with term definitions, related terms, and full-text search.',
    endpoints: [
      {
        method: 'GET', path: '/api/glossary', description: 'List all glossary terms, optionally filtered by search query. Sorted alphabetically.',
        request: 'Query: ?q=attention (optional, searches term and definition)',
        response: '{ "terms": [{ "id": "gl_...", "term": "Attention", "definition": "A mechanism for...", "relatedTerms": ["transformer"], "references": ["vaswani2017"], "createdAt": "..." }], "total": 25 }',
      },
      {
        method: 'POST', path: '/api/glossary', description: 'Add a new glossary term. Fails with 409 if the term already exists (case-insensitive). Rate-limited to 30/min per IP.',
        request: '{ "term": "Attention", "definition": "A mechanism for weighting input relevance.", "relatedTerms": ["transformer", "softmax"], "references": ["vaswani2017"] }',
        response: '{ "success": true, "entry": { "id": "gl_...", "term": "Attention", "definition": "...", "relatedTerms": [...], "references": [...], "createdAt": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/glossary', description: 'Delete a glossary term by ID.',
        request: '{ "id": "gl_..." }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'tasks',
    title: 'Tasks (Kanban)',
    icon: '\u{2705}',
    description: 'Task management with kanban-style statuses (todo, doing, done) and priority levels.',
    endpoints: [
      {
        method: 'POST', path: '/api/tasks', description: 'Create a new task. Rate-limited to 60/min per IP.',
        request: '{ "title": "Review paper draft", "description": "Check citations and formatting", "status": "todo", "priority": "high" }\n\nValid statuses: "todo", "doing", "done"\nValid priorities: "low", "medium", "high"',
        response: '{ "success": true, "task": { "id": "...", "title": "...", "description": "...", "status": "todo", "priority": "high", "createdAt": "...", "updatedAt": "..." } }',
      },
      {
        method: 'GET', path: '/api/tasks', description: 'List all tasks, grouped by status with counts.',
        response: '{ "tasks": [...], "grouped": { "todo": [...], "doing": [...], "done": [...] }, "counts": { "todo": 3, "doing": 1, "done": 5 } }',
      },
      {
        method: 'PUT', path: '/api/tasks', description: 'Update a task\'s title, description, status, or priority. Rate-limited to 60/min per IP.',
        request: '{ "id": "abc123", "status": "doing", "priority": "high" }',
        response: '{ "success": true, "task": { "id": "abc123", "status": "doing", "priority": "high", "updatedAt": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/tasks', description: 'Delete a task by ID. Rate-limited to 30/min per IP.',
        request: '{ "id": "abc123" }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'goals',
    title: 'Writing Goals',
    icon: '\u{1F3AF}',
    description: 'Daily and weekly word-count writing goals with progress tracking against a baseline.',
    endpoints: [
      {
        method: 'POST', path: '/api/goals', description: 'Create or replace a writing goal. Computes a baseline word count from all content files. Rate-limited to 30/min per IP.',
        request: '{ "type": "daily", "target": 500, "userId": "default" }\n\nValid types: "daily", "weekly"',
        response: '{ "id": "goal_...", "type": "daily", "target": 500, "userId": "default", "startDate": "2025-01-15", "baselineWords": 125000, "createdAt": "..." }',
      },
      {
        method: 'GET', path: '/api/goals', description: 'Get all goals for a user with current progress. Shows words written since goal creation and expiration status.',
        request: 'Query: ?userId=default',
        response: '{ "goals": [{ "id": "goal_...", "type": "daily", "target": 500, "currentWords": 125350, "wordsWritten": 350, "progress": 0.7, "isExpired": false, ... }] }',
      },
      {
        method: 'PUT', path: '/api/goals', description: 'Update a goal\'s target word count. Rate-limited to 30/min per IP.',
        request: '{ "id": "goal_...", "target": 750 }',
        response: '{ "id": "goal_...", "type": "daily", "target": 750, ... }',
      },
    ],
  },
  {
    id: 'snapshots',
    title: 'Snapshots',
    icon: '\u{1F4F8}',
    description: 'Named file snapshots for manual versioning. Each file can have up to 10 snapshots (oldest pruned automatically).',
    endpoints: [
      {
        method: 'POST', path: '/api/snapshots', description: 'Create a named snapshot of a file\'s current content. Rate-limited to 30/min per IP.',
        request: '{ "path": "content/docs/example.md", "name": "Before major rewrite" }',
        response: '{ "success": true, "snapshot": { "id": "uuid", "name": "Before major rewrite", "createdAt": "..." } }',
      },
      {
        method: 'GET', path: '/api/snapshots', description: 'List all snapshots for a file.',
        request: 'Query: ?path=content/docs/example.md',
        response: '{ "snapshots": [{ "id": "uuid", "name": "Before major rewrite", "createdAt": "..." }] }',
      },
      {
        method: 'POST', path: '/api/snapshots/restore', description: 'Restore a file to a previous snapshot\'s content. Rate-limited to 30/min per IP.',
        request: '{ "path": "content/docs/example.md", "snapshotId": "uuid" }',
        response: '{ "success": true, "restored": { "id": "uuid", "name": "Before major rewrite" } }',
      },
      {
        method: 'DELETE', path: '/api/snapshots', description: 'Delete a specific snapshot. Rate-limited to 30/min per IP.',
        request: '{ "path": "content/docs/example.md", "snapshotId": "uuid" }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'schedule',
    title: 'Scheduled Publishing',
    icon: '\u{1F4C5}',
    description: 'Schedule content files for future publication. Maintains a list of scheduled items, each with a publish-at date, optional note, and status.',
    endpoints: [
      {
        method: 'POST', path: '/api/schedule', description: 'Schedule a file for publication at a future date. An optional note can be attached. Each call adds a new scheduled item.',
        request: '{ "path": "content/docs/upcoming.md", "publishAt": "2025-02-01T09:00:00Z", "note": "Launch announcement" }',
        response: '{ "success": true, "item": { "id": "sched_...", "path": "content/docs/upcoming.md", "publishAt": "2025-02-01T09:00:00Z", "note": "Launch announcement", "createdAt": "...", "status": "scheduled" } }',
      },
      {
        method: 'GET', path: '/api/schedule', description: 'List all scheduled items sorted by publish date. Past-due scheduled items are reported as due. Includes counts of upcoming and due items.',
        response: '{ "items": [{ "id": "sched_...", "path": "content/docs/upcoming.md", "publishAt": "2025-02-01T09:00:00Z", "note": "", "createdAt": "...", "status": "scheduled" }], "upcoming": 1, "due": 0 }',
      },
      {
        method: 'DELETE', path: '/api/schedule', description: 'Cancel a scheduled item by its id.',
        request: '{ "id": "sched_..." }',
        response: '{ "success": true }',
      },
    ],
  },
  {
    id: 'quicknote',
    title: 'Quick Notes',
    icon: '\u{26A1}',
    description: 'Fast-capture notes saved as draft blog posts with the quick-note tag. Also supports JSON-backed scratchpad notes.',
    endpoints: [
      {
        method: 'POST', path: '/api/quicknote', description: 'Create a quick note as a markdown file in content/posts/blog/. Auto-generates a date-prefixed filename. Rate-limited to 20/min per IP.',
        request: '{ "text": "Interesting idea about attention heads...", "title": "Attention Head Hypothesis" }',
        response: '{ "success": true, "path": "content/posts/blog/2025-01-15-attention-head-hypothesis.md", "filename": "2025-01-15-attention-head-hypothesis.md" }',
      },
      {
        method: 'GET', path: '/api/quicknote', description: 'List the 10 most recent quick notes (blog posts tagged quick-note), newest first.',
        response: '{ "notes": [{ "filename": "2025-01-15-attention-head-hypothesis.md", "title": "Attention Head Hypothesis", "date": "2025-01-15", "preview": "Interesting idea about...", "path": "content/posts/blog/2025-01-15-attention-head-hypothesis.md" }], "total": 3 }',
      },
      {
        method: 'GET', path: '/api/quicknotes', description: 'List all JSON-backed quick notes plus blog quick notes, sorted newest first.',
        request: 'Query: ?userId=default',
        response: '[{ "id": "qn_...", "text": "...", "color": "#fef3c7", "createdAt": "...", "updatedAt": "..." }, ...]',
      },
      {
        method: 'POST', path: '/api/quicknotes', description: 'Create a JSON-backed quick note with optional color. Max 200 per user. Rate-limited to 30/min per IP.',
        request: '{ "userId": "default", "text": "Remember to check citation graph", "color": "#dbeafe" }',
        response: '{ "success": true, "note": { "id": "qn_...", "text": "...", "color": "#dbeafe", "createdAt": "...", "updatedAt": "..." } }',
      },
      {
        method: 'DELETE', path: '/api/quicknotes', description: 'Delete a JSON-backed quick note by ID.',
        request: '{ "userId": "default", "id": "qn_..." }',
        response: '{ "success": true }',
      },
    ],
  },
];

function TableOfContents() {
  return (
    <nav style={{
      background: 'var(--ifm-code-background, #f8f9fa)',
      border: '1px solid var(--ifm-table-border-color, #e5e7eb)',
      borderRadius: '8px',
      padding: '16px 20px',
      marginBottom: '2rem',
    }}>
      <h3 style={{margin: '0 0 12px 0', fontSize: '1rem'}}>Categories</h3>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
        {CATEGORIES.map(cat => (
          <a
            key={cat.id}
            href={`#${cat.id}`}
            style={{
              display: 'inline-block',
              padding: '4px 12px',
              borderRadius: '16px',
              fontSize: '0.85rem',
              textDecoration: 'none',
              background: 'var(--ifm-background-color, white)',
              border: '1px solid var(--ifm-table-border-color, #d1d5db)',
              color: 'var(--ifm-font-color-base)',
              transition: 'border-color 0.15s',
            }}
          >
            {cat.icon} {cat.title}
            <span style={{
              marginLeft: '6px',
              fontSize: '0.75rem',
              color: '#9ca3af',
            }}>
              {cat.endpoints.length}
            </span>
          </a>
        ))}
      </div>
    </nav>
  );
}

export default function ApiDocs() {
  const totalEndpoints = CATEGORIES.reduce((sum, cat) => sum + cat.endpoints.length, 0);

  return (
    <Layout title="API Documentation" description="API documentation for Mochi Lab editor server">
      <ErrorBoundary>
      <main style={{
        maxWidth: '960px',
        margin: '0 auto',
        padding: '2rem 1.5rem',
      }}>
        <div style={{marginBottom: '2rem'}}>
          <h1 style={{marginBottom: '8px'}}>API Reference</h1>
          <p style={{color: '#6b7280', fontSize: '1rem', marginBottom: '4px'}}>
            Documentation for the Mochi Lab editor server API &mdash; {totalEndpoints} endpoints across {CATEGORIES.length} categories.
          </p>
          <p style={{color: '#9ca3af', fontSize: '0.85rem'}}>
            Base URL: <code>http://localhost:3001</code> (configurable via <code>EDITOR_PORT</code> env var). All request/response bodies are JSON unless noted otherwise.
          </p>
        </div>

        <TableOfContents />

        {CATEGORIES.map(cat => (
          <CategorySection key={cat.id} {...cat} />
        ))}

        <footer style={{
          borderTop: '1px solid var(--ifm-table-border-color, #e5e7eb)',
          paddingTop: '1rem',
          marginTop: '2rem',
          color: '#9ca3af',
          fontSize: '0.8rem',
        }}>
          <p><strong>Error responses</strong> follow the format: <code>{'{ "error": "Error message" }'}</code></p>
          <p><strong>Rate limiting</strong> returns HTTP 429 with <code>{'{ "error": "Too many requests. Try again in a minute." }'}</code></p>
          <p><strong>ETag caching</strong> is enabled for all GET endpoints. Responses include an <code>ETag</code> header; send <code>If-None-Match</code> to receive 304 Not Modified.</p>
          <p><strong>CORS</strong> is enabled for all origins by default (configurable via <code>CORS_ORIGIN</code> env var). Max request body size: 10 MB.</p>
        </footer>
      </main>
      </ErrorBoundary>
    </Layout>
  );
}
