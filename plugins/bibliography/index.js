const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFERENCES = new Set([
  'NeurIPS', 'NIPS', 'ICML', 'ICLR',
  'CVPR', 'ICCV', 'ECCV', 'BMVC',
  'ACL', 'EMNLP', 'NAACL', 'EACL', 'COLING', 'CoNLL',
  'AAAI', 'IJCAI', 'UAI', 'AISTATS', 'COLT',
  'KDD', 'SIGIR', 'WWW', 'WSDM', 'CIKM', 'RecSys',
  'SIGMOD', 'VLDB', 'ICDE',
  'OSDI', 'SOSP', 'NSDI', 'ATC', 'EuroSys', 'SoCC', 'MLSys',
  'PLDI', 'POPL', 'OOPSLA', 'ICFP',
  'ICSE', 'FSE', 'ASE', 'ISSTA',
  'MICCAI',
  'RSS', 'ICRA', 'IROS', 'CoRL',
  'SIGGRAPH',
  'CHI', 'UIST', 'CSCW',
  'CCS', 'NDSS', 'AISec',
  'STOC', 'FOCS', 'SODA',
  'INTERSPEECH', 'ICASSP',
  'TREC',
  'EMNLP Findings', 'ACL Findings', 'NAACL Findings',
]);

const PDF_NAME = 'paper.pdf';
const SOURCE_NAME = 'source.tar.gz';
const BIB_FILES_DIR = 'bib-files';

function inferBibtexType(entry) {
  const t = (entry.type || 'misc').toLowerCase();
  if (t === 'book') return 'book';
  if (t === 'inproceedings') return 'inproceedings';
  if (t === 'phdthesis' || t === 'thesis') return 'phdthesis';
  if (t === 'techreport') return 'techreport';

  const venue = entry.venue || '';
  if (CONFERENCES.has(venue)) return 'inproceedings';
  if (/proceedings|conference|workshop|symposium|findings/i.test(venue)) {
    return 'inproceedings';
  }

  if (t === 'article') return 'article';
  return 'misc';
}

function toBibtex(key, entry) {
  const bibtexType = inferBibtexType(entry);
  const authors = (entry.author || []).join(' and ');
  const fields = [];

  fields.push(`  title = {${entry.title || ''}}`);
  if (authors) fields.push(`  author = {${authors}}`);
  if (entry.year) fields.push(`  year = {${entry.year}}`);

  if (entry.venue) {
    if (bibtexType === 'inproceedings') {
      fields.push(`  booktitle = {${entry.venue}}`);
    } else if (bibtexType === 'article') {
      fields.push(`  journal = {${entry.venue}}`);
    } else if (bibtexType === 'book') {
      fields.push(`  publisher = {${entry.venue}}`);
    } else {
      fields.push(`  howpublished = {${entry.venue}}`);
    }
  }

  if (entry.url) fields.push(`  url = {${entry.url}}`);
  if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
  if (entry.volume) fields.push(`  volume = {${entry.volume}}`);
  if (entry.pages) fields.push(`  pages = {${entry.pages}}`);

  return `@${bibtexType}{${key},\n${fields.join(',\n')}\n}`;
}

function extractArxivId(url) {
  if (!url) return null;
  const m = url.match(/arxiv\.org\/abs\/([\d.]+)/);
  return m ? m[1] : null;
}

module.exports = function bibliographyPlugin() {
  const projectDir = path.resolve(__dirname, '..', '..');
  const bibPath = path.join(projectDir, 'content', 'bibliography', 'references.yaml');
  const notesDir = path.join(projectDir, 'notes');
  const rawDir = path.join(projectDir, 'raw', 'bibliography');

  return {
    name: 'bibliography',

    getPathsToWatch() {
      return [bibPath, `${notesDir}/**/*.md`];
    },

    async loadContent() {
      let references = {};
      try {
        references = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
      } catch (err) {
        console.warn(`[bibliography] Could not load ${bibPath}: ${err.message}`);
        return {};
      }

      const enhanced = {};
      for (const [key, entry] of Object.entries(references)) {
        const itemDir = path.join(rawDir, key);
        const hasPdf = fs.existsSync(path.join(itemDir, PDF_NAME));
        const hasLatex = fs.existsSync(path.join(itemDir, SOURCE_NAME));

        // The "special note" written when raw artifacts could not be retrieved.
        let notFound = '';
        try {
          const nfPath = path.join(itemDir, 'NOT_FOUND.md');
          if (fs.existsSync(nfPath)) notFound = fs.readFileSync(nfPath, 'utf8');
        } catch (_) {}

        let notes = '';
        try {
          const notePath = path.join(notesDir, `${key}.md`);
          if (fs.existsSync(notePath)) {
            notes = fs.readFileSync(notePath, 'utf8');
          }
        } catch (_) {}

        enhanced[key] = {
          ...entry,
          bibtex: toBibtex(key, entry),
          notes,
          raw: {
            hasPdf,
            hasLatex,
            notFound,
            // Files served from the build output (see postBuild). Present only
            // when the local raw archive has been populated at build time.
            pdfUrl: hasPdf ? `/${BIB_FILES_DIR}/${key}/${PDF_NAME}` : null,
            sourceUrl: hasLatex ? `/${BIB_FILES_DIR}/${key}/${SOURCE_NAME}` : null,
          },
          arxivId: extractArxivId(entry.url),
        };
      }

      return enhanced;
    },

    async contentLoaded({ content, actions }) {
      const { setGlobalData, addRoute } = actions;

      // `command` is the plugin contract with the shell: every plugin that
      // wants a way in declares one, and src/components/commands.js collects
      // them out of global data. The CLI and the Cmd+K palette then list this
      // tool without either of them naming it. `icon` is a key rather than the
      // SVG itself, because global data has to survive being serialized.
      setGlobalData({
        references: content,
        command: {
          id: 'bibliography',
          name: 'bibliography',
          category: 'Tools',
          icon: 'book',
          title: 'Bibliography',
          description: 'Browse and manage references',
          href: '/bibliography',
        },
      });

      // The plugin owns its pages, index and item alike. They used to live in
      // src/pages and src/components, where the shell auto-routed one of them
      // and the other was reached by the route below: two halves of one tool,
      // filed under the framework's folders rather than the tool's.
      addRoute({
        path: '/bibliography',
        component: '@site/plugins/bibliography/components/Page',
        exact: true,
      });

      for (const key of Object.keys(content)) {
        addRoute({
          path: `/bibliography/${key}`,
          component: '@site/plugins/bibliography/components/Item',
          exact: true,
        });
      }
    },

    // Copy populated raw artifacts (PDF + LaTeX source) into the build output so
    // each item's raw files are downloadable from the site. Files live in the
    // gitignored raw/ archive, so this only emits what exists locally at build
    // time; missing artifacts surface as the item's "special note" instead.
    async postBuild({ outDir }) {
      if (!fs.existsSync(rawDir)) return;
      const destRoot = path.join(outDir, BIB_FILES_DIR);
      let copied = 0;
      for (const key of fs.readdirSync(rawDir)) {
        const itemDir = path.join(rawDir, key);
        if (!fs.statSync(itemDir).isDirectory()) continue;
        for (const fname of [PDF_NAME, SOURCE_NAME]) {
          const src = path.join(itemDir, fname);
          if (!fs.existsSync(src)) continue;
          const dest = path.join(destRoot, key, fname);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          copied++;
        }
      }
      console.log(`[bibliography] copied ${copied} raw file(s) into ${path.relative(outDir, destRoot)}/`);
    },
  };
};
