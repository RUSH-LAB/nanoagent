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
  const projectDir = path.resolve(__dirname, '..');
  const bibPath = path.join(projectDir, 'references.yaml');
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
        const hasPdf = fs.existsSync(path.join(itemDir, 'paper.pdf'));
        const hasLatex = fs.existsSync(path.join(itemDir, 'source.tar.gz'));

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
            pdfUrl: hasPdf ? `/bib-files/${key}/paper.pdf` : null,
            sourceUrl: hasLatex ? `/bib-files/${key}/source.tar.gz` : null,
          },
          arxivId: extractArxivId(entry.url),
        };
      }

      return enhanced;
    },

    async contentLoaded({ content, actions }) {
      const { setGlobalData, addRoute } = actions;
      setGlobalData({ references: content });

      for (const key of Object.keys(content)) {
        addRoute({
          path: `/bibliography/${key}`,
          component: '@site/src/components/BibliographyItem',
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
      const destRoot = path.join(outDir, 'bib-files');
      let copied = 0;
      for (const key of fs.readdirSync(rawDir)) {
        const itemDir = path.join(rawDir, key);
        if (!fs.statSync(itemDir).isDirectory()) continue;
        for (const fname of ['paper.pdf', 'source.tar.gz']) {
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
