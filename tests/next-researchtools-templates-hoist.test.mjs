import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// research-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const { BUILTIN_TEMPLATES } = researchTools;

// Drive the GET /api/templates handler with a minimal mocked ctx and capture the
// response handed to json(res, status, payload, opts). The handler only reads
// ctx.json, so an otherwise empty ctx suffices (modeled on tests/feeds-guard.test.mjs).
async function getTemplates() {
  const url = new URL('http://localhost/api/templates');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    json(_res, status, payload, opts) {
      captured = { status, payload, opts };
      res.writableEnded = true;
      return captured;
    },
  };
  await researchTools(req, res, url, '/api/templates', ctx);
  return captured;
}

// The exact payload the hoisted const must serialize to. Locks the bytes so any
// drift in the five template literals fails the suite.
const EXPECTED = {
  templates: [
    {id: 'blank', name: 'Blank Page', content: '---\ntitle: "Untitled"\ndate: {{date}}\n---\n\n# Untitled\n\n'},
    {id: 'blog', name: 'Blog Post', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zeyu]\ntags: []\n---\n\n# {{title}}\n\n## Introduction\n\n## Main Content\n\n## Conclusion\n'},
    {id: 'research', name: 'Research Paper Summary', content: '---\ntitle: "{{title}}"\ndate: {{date}}\nauthors: [zeyu]\ntags: [research]\n---\n\n# {{title}}\n\n## Summary\n\n## Key Contributions\n\n## Method\n\n## Results\n\n## Discussion\n\n## References\n'},
    {id: 'math', name: 'Math Chapter', content: '---\ntitle: "{{title}}"\n---\n\nimport {Theorem, Definition, Proof, Remark} from \'@site/src/components/Math\';\n\n# {{title}}\n\n<Definition id="def-1" name="Definition Name">\nDefinition content.\n</Definition>\n\n<Theorem id="thm-1" name="Theorem Name">\nTheorem statement.\n</Theorem>\n\n<Proof>\nProof content.\n</Proof>\n'},
    {id: 'tutorial', name: 'Tutorial', content: '---\ntitle: "{{title}}"\nsidebar_position: 1\n---\n\n# {{title}}\n\n## Prerequisites\n\n## Step 1\n\n## Step 2\n\n## Step 3\n\n## Summary\n'},
  ],
};

describe('BUILTIN_TEMPLATES module-scope hoist', () => {
  it('is exported as a frozen length-5 array', () => {
    assert.ok(Array.isArray(BUILTIN_TEMPLATES));
    assert.equal(BUILTIN_TEMPLATES.length, 5);
    assert.equal(Object.isFrozen(BUILTIN_TEMPLATES), true);
  });

  it('is referentially stable across requires (built once at module load)', () => {
    const again = require('../server/routes/research-tools.js').BUILTIN_TEMPLATES;
    assert.ok(Array.isArray(again) && again.length === 5, 'export resolves to the array, not undefined');
    assert.strictEqual(again, BUILTIN_TEMPLATES);
  });

  it('lists the five built-in template ids in order', () => {
    assert.deepEqual(BUILTIN_TEMPLATES.map(t => t.id), ['blank', 'blog', 'research', 'math', 'tutorial']);
  });

  it('GET /api/templates serves the hoisted instance with status 200', async () => {
    const r = await getTemplates();
    assert.equal(r.status, 200);
    assert.strictEqual(r.payload.templates, BUILTIN_TEMPLATES);
    assert.deepEqual(r.opts, { cacheControl: 'public, max-age=3600' });
  });

  it('payload deep-equals the locked expected object (byte-stable)', async () => {
    const r = await getTemplates();
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('two back-to-back invocations return the same templates reference', async () => {
    const a = await getTemplates();
    const b = await getTemplates();
    assert.strictEqual(a.payload.templates, b.payload.templates);
    assert.strictEqual(a.payload.templates, BUILTIN_TEMPLATES);
  });
});
