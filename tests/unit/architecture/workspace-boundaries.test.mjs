import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

describe('platform and workspace ownership boundaries', () => {
  it('keeps organization navigation out of the universal Docusaurus build config', () => {
    const config = read('docusaurus.config.js');
    assert.doesNotMatch(config, /\/documents\/(?:books|posts)\//);
    assert.doesNotMatch(config, /Innovative Research & Development/);
    assert.match(config, /workspace_settings/);
  });

  it('keeps organization collection conventions out of the shared resolver', () => {
    const resolver = read('src/server/workspace-site.js');
    for (const organizationConvention of ['books/builder', "key === 'research'", "['books', 'posts']"]) {
      assert.equal(resolver.includes(organizationConvention), false, organizationConvention);
    }
  });

  it('builds content commands from workspace settings rather than a shared list', () => {
    const commands = read('src/components/commands.js');
    assert.doesNotMatch(commands, /\/documents\/posts\/research/);
    assert.doesNotMatch(commands, /\/documents\/books\/math/);
    assert.match(commands, /workspaceSite\?\.navigation/);
  });

  it('keeps personal settings free of navigation and groups navbar links by content type', () => {
    const settings = read('src/pages/settings/index.js');
    const navbar = read('src/theme/Navbar/Content/index.tsx');
    assert.doesNotMatch(settings, /site\/navigation|workspace-navigation/);
    assert.match(navbar, /label: 'Book'/);
    assert.match(navbar, /label: 'Blog'/);
    assert.match(navbar, /collection\.type === 'docs'/);
    assert.match(navbar, /collection\.type === 'blog'/);
    assert.doesNotMatch(navbar, /NavbarNavigationEditor/);
  });

  it('keeps appearance controls out of account settings', () => {
    const settings = read('src/pages/settings/index.js');
    assert.doesNotMatch(settings, /useColorMode|api\/preferences|id="appearance"/);
  });

  it('does not reuse the previous workspace presentation while a new URL loads', () => {
    const hook = read('src/hooks/useWorkspaceSite.js');
    const switcher = read('src/components/WorkspaceSwitcher/index.js');
    const commands = read('src/components/commands.js');
    assert.match(hook, /state\.slug === slug \? state : cachedState\(slug\)/);
    assert.match(switcher, /const active = routeSlug\s*\? workspaces\?\.find/);
    assert.match(commands, /workspaceSlug && !workspaceSite/);
  });

  it('keeps infrastructure outside executable application source', () => {
    assert.equal(fs.existsSync(path.join(root, 'infra')), true);
    assert.equal(fs.existsSync(path.join(root, 'src', 'infra')), false);
  });

  it('uses one deployment manifest rather than organization packages', () => {
    const manifest = JSON.parse(read('package.json'));
    assert.equal(manifest.name, 'mochi-lab');
    assert.equal(fs.existsSync(path.join(root, 'workspaces')), false);
  });
});
