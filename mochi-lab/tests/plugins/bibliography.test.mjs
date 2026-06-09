import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bibliographyPlugin = require('../../plugins/docusaurus-plugin-bibliography');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const pluginDir = path.dirname(
  require.resolve('../../plugins/docusaurus-plugin-bibliography'),
);
const projectDir = path.resolve(pluginDir, '..');
const bibPath = path.join(projectDir, 'references.yaml');
const rawBib = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};

// Pick keys with known characteristics for targeted tests
const allKeys = Object.keys(rawBib);

const bookKey = allKeys.find((k) => rawBib[k].type === 'book');
const inprocKey = allKeys.find((k) => rawBib[k].type === 'inproceedings');
const articleKey = allKeys.find(
  (k) =>
    rawBib[k].type === 'article' &&
    rawBib[k].venue &&
    // Pick one whose venue is NOT a conference (so inferBibtexType returns 'article')
    !/^(NeurIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|KDD|SIGIR|MICCAI|ICRA|RSS|CHI|STOC|FOCS)$/i.test(
      rawBib[k].venue,
    ) &&
    !/proceedings|conference|workshop|symposium|findings/i.test(rawBib[k].venue),
);
const arxivKey = allKeys.find(
  (k) => rawBib[k].url && /arxiv\.org\/abs\//.test(rawBib[k].url),
);
const nonArxivUrlKey = allKeys.find(
  (k) =>
    rawBib[k].url &&
    !/arxiv\.org\/abs\//.test(rawBib[k].url) &&
    !k.startsWith('__test'),
);
const keyWithDoi = allKeys.find((k) => rawBib[k].doi);
// A key whose venue is in the CONFERENCES set (so inferBibtexType returns 'inproceedings')
const conferenceVenueKey = allKeys.find(
  (k) =>
    rawBib[k].type === 'article' &&
    rawBib[k].venue &&
    /^(NeurIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|KDD|MICCAI|ICRA|RSS|CHI)$/i.test(
      rawBib[k].venue,
    ),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bibliographyPlugin', () => {
  let plugin;
  let content;

  before(async () => {
    plugin = bibliographyPlugin();
    content = await plugin.loadContent();
  });

  // ---- Plugin metadata ----

  describe('plugin metadata', () => {
    it('has the name "bibliography"', () => {
      assert.equal(plugin.name, 'bibliography');
    });

    it('getPathsToWatch returns references.yaml and notes glob', () => {
      const paths = plugin.getPathsToWatch();
      assert.ok(Array.isArray(paths));
      assert.equal(paths.length, 2);
      assert.ok(paths[0].endsWith('references.yaml'));
      assert.ok(paths[1].includes('notes'));
      assert.ok(paths[1].endsWith('**/*.md'));
    });
  });

  // ---- loadContent basics ----

  describe('loadContent', () => {
    it('returns an object with entries', () => {
      assert.ok(content);
      assert.equal(typeof content, 'object');
      assert.ok(Object.keys(content).length > 0);
    });

    it('returns the same keys as references.yaml (non-test entries)', () => {
      // The content should have at least as many keys as the raw bib
      for (const key of allKeys) {
        assert.ok(key in content, `missing key: ${key}`);
      }
    });

    it('each entry preserves original fields', () => {
      const key = allKeys[0];
      assert.equal(content[key].title, rawBib[key].title);
      assert.equal(content[key].year, rawBib[key].year);
      assert.deepStrictEqual(content[key].author, rawBib[key].author);
    });
  });

  // ---- bibtex field ----

  describe('bibtex generation', () => {
    it('each entry has a bibtex string field', () => {
      for (const key of allKeys.slice(0, 5)) {
        assert.equal(typeof content[key].bibtex, 'string');
        assert.ok(content[key].bibtex.length > 0);
      }
    });

    it('bibtex starts with @type{key,', () => {
      const key = allKeys[0];
      const bib = content[key].bibtex;
      assert.ok(bib.startsWith('@'), `bibtex should start with @: ${bib}`);
      assert.ok(bib.includes(`{${key},`), `bibtex should contain {${key},`);
    });

    it('bibtex contains the title', () => {
      const key = allKeys[0];
      assert.ok(content[key].bibtex.includes(rawBib[key].title));
    });

    it('bibtex contains the year', () => {
      const key = allKeys[0];
      if (rawBib[key].year) {
        assert.ok(content[key].bibtex.includes(String(rawBib[key].year)));
      }
    });

    it('bibtex joins authors with " and "', () => {
      const key = allKeys.find(
        (k) => rawBib[k].author && rawBib[k].author.length >= 2,
      );
      if (!key) return;
      const bib = content[key].bibtex;
      assert.ok(
        bib.includes(' and '),
        'multiple authors should be joined with " and "',
      );
    });

    it('book type produces @book bibtex', () => {
      if (!bookKey) return;
      assert.ok(
        content[bookKey].bibtex.startsWith('@book{'),
        `expected @book for ${bookKey}: ${content[bookKey].bibtex.slice(0, 30)}`,
      );
    });

    it('book type uses publisher for venue', () => {
      if (!bookKey) return;
      const bib = content[bookKey].bibtex;
      if (rawBib[bookKey].venue) {
        assert.ok(
          bib.includes('publisher'),
          'book should use publisher field for venue',
        );
      }
    });

    it('explicit inproceedings type produces @inproceedings bibtex', () => {
      if (!inprocKey) return;
      assert.ok(
        content[inprocKey].bibtex.startsWith('@inproceedings{'),
        `expected @inproceedings for ${inprocKey}`,
      );
    });

    it('inproceedings uses booktitle for venue', () => {
      if (!inprocKey) return;
      const bib = content[inprocKey].bibtex;
      if (rawBib[inprocKey].venue) {
        assert.ok(
          bib.includes('booktitle'),
          'inproceedings should use booktitle field',
        );
      }
    });

    it('article with non-conference venue produces @article bibtex', () => {
      if (!articleKey) return;
      assert.ok(
        content[articleKey].bibtex.startsWith('@article{'),
        `expected @article for ${articleKey}: ${content[articleKey].bibtex.slice(0, 40)}`,
      );
    });

    it('article uses journal for venue', () => {
      if (!articleKey) return;
      const bib = content[articleKey].bibtex;
      if (rawBib[articleKey].venue) {
        assert.ok(
          bib.includes('journal'),
          'article should use journal field for venue',
        );
      }
    });

    it('article type with conference venue infers @inproceedings', () => {
      if (!conferenceVenueKey) return;
      assert.ok(
        content[conferenceVenueKey].bibtex.startsWith('@inproceedings{'),
        `expected @inproceedings for article with conference venue: ${conferenceVenueKey}`,
      );
    });

    it('bibtex includes url field when present', () => {
      if (!arxivKey) return;
      const bib = content[arxivKey].bibtex;
      assert.ok(bib.includes('url = {'), 'bibtex should include url field');
    });

    it('bibtex includes doi field when present', () => {
      if (!keyWithDoi) return;
      const bib = content[keyWithDoi].bibtex;
      assert.ok(bib.includes('doi = {'), 'bibtex should include doi field');
    });
  });

  // ---- arxivId ----

  describe('arxivId extraction', () => {
    it('extracts arxivId from arxiv.org URL', () => {
      if (!arxivKey) return;
      const entry = content[arxivKey];
      assert.ok(entry.arxivId, `expected arxivId for ${arxivKey}`);
      // The arxivId should be a numeric pattern like "1234.56789"
      assert.ok(
        /^\d+\.\d+$/.test(entry.arxivId),
        `arxivId should be numeric: ${entry.arxivId}`,
      );
    });

    it('arxivId is null for non-arxiv URLs', () => {
      if (!nonArxivUrlKey) return;
      assert.equal(
        content[nonArxivUrlKey].arxivId,
        null,
        `expected null arxivId for non-arxiv URL: ${rawBib[nonArxivUrlKey].url}`,
      );
    });

    it('arxivId matches the ID in the URL', () => {
      if (!arxivKey) return;
      const url = rawBib[arxivKey].url;
      const expectedId = url.match(/arxiv\.org\/abs\/([\d.]+)/)[1];
      assert.equal(content[arxivKey].arxivId, expectedId);
    });
  });

  // ---- raw field ----

  describe('raw artifacts', () => {
    it('each entry has a raw object', () => {
      const key = allKeys[0];
      assert.ok(content[key].raw);
      assert.equal(typeof content[key].raw, 'object');
    });

    it('raw object has hasPdf boolean', () => {
      const key = allKeys[0];
      assert.equal(typeof content[key].raw.hasPdf, 'boolean');
    });

    it('raw object has hasLatex boolean', () => {
      const key = allKeys[0];
      assert.equal(typeof content[key].raw.hasLatex, 'boolean');
    });

    it('pdfUrl is set when hasPdf is true, null otherwise', () => {
      const key = allKeys[0];
      if (content[key].raw.hasPdf) {
        assert.equal(
          content[key].raw.pdfUrl,
          `/bib-files/${key}/paper.pdf`,
        );
      } else {
        assert.equal(content[key].raw.pdfUrl, null);
      }
    });

    it('sourceUrl is set when hasLatex is true, null otherwise', () => {
      const key = allKeys[0];
      if (content[key].raw.hasLatex) {
        assert.equal(
          content[key].raw.sourceUrl,
          `/bib-files/${key}/source.tar.gz`,
        );
      } else {
        assert.equal(content[key].raw.sourceUrl, null);
      }
    });
  });

  // ---- notes field ----

  describe('notes', () => {
    it('each entry has a notes string field', () => {
      const key = allKeys[0];
      assert.equal(typeof content[key].notes, 'string');
    });
  });

  // ---- contentLoaded ----

  describe('contentLoaded', () => {
    it('sets global data with references', async () => {
      let globalData = null;
      const routes = [];
      const mockActions = {
        setGlobalData(data) {
          globalData = data;
        },
        addRoute(route) {
          routes.push(route);
        },
      };

      await plugin.contentLoaded({ content, actions: mockActions });

      assert.ok(globalData);
      assert.ok(globalData.references);
      assert.deepStrictEqual(globalData.references, content);
    });

    it('adds a route for each bibliography entry', async () => {
      const routes = [];
      const mockActions = {
        setGlobalData() {},
        addRoute(route) {
          routes.push(route);
        },
      };

      await plugin.contentLoaded({ content, actions: mockActions });

      assert.equal(routes.length, Object.keys(content).length);
    });

    it('each route has the correct path format', async () => {
      const routes = [];
      const mockActions = {
        setGlobalData() {},
        addRoute(route) {
          routes.push(route);
        },
      };

      await plugin.contentLoaded({ content, actions: mockActions });

      for (const route of routes) {
        assert.ok(
          route.path.startsWith('/bibliography/'),
          `route path should start with /bibliography/: ${route.path}`,
        );
        assert.equal(route.exact, true);
        assert.equal(
          route.component,
          '@site/src/components/BibliographyItem',
        );
      }
    });

    it('route keys match content keys', async () => {
      const routes = [];
      const mockActions = {
        setGlobalData() {},
        addRoute(route) {
          routes.push(route);
        },
      };

      await plugin.contentLoaded({ content, actions: mockActions });

      const routeKeys = routes.map((r) =>
        r.path.replace('/bibliography/', ''),
      );
      const contentKeys = Object.keys(content);
      assert.deepStrictEqual(routeKeys.sort(), contentKeys.sort());
    });
  });
});
