import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {as, migratedDatabase, pgQuery} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {importLegacyContent} = require('../../../../src/server/fs/import.js');
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createFsDocuments} = require('../../../../src/server/fs/documents.js');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');

describe('importing legacy content into the file system', () => {
  let db;
  let owner;
  let fs;

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    // The schema owner's connection, which row-level security does not restrict.
    owner = {async connect() { return {query: pgQuery(db), release() {}}; }};
    fs = createPostgresFs({pool: database.pool});
    await db.exec(`
      insert into document(id, workspace_id, path, title, markdown, visibility, created_by, created_at, updated_at, deleted_at) values
        ('doc-intro', 'lab', 'books/guide/intro.md', 'Intro', '# Intro v3', 'org', 'alice', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', null),
        ('doc-secret', 'lab', 'journal/secret.md', 'Secret', 'mine', 'private', 'bob', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', null),
        ('doc-old', 'lab', 'posts/old.md', 'Old', 'gone', 'org', 'alice', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z');
      insert into document_version(id, workspace_id, document_id, seq, markdown, author_id, created_at) values
        ('v1', 'lab', 'doc-intro', 1, '# Intro v1', 'bob', '2026-01-02T00:00:00Z'),
        ('v2', 'lab', 'doc-intro', 2, '# Intro v2', 'alice', '2026-01-03T00:00:00Z');
      insert into object_blob(object_key, workspace_id, body, content_type, byte_size, sha256) values
        ('lab/content/${sha('png')}/books/guide/plot.png', 'lab', convert_to('png', 'UTF8'), 'image/png', 3, '${sha('png')}'),
        ('lab/assets/blob-1/${sha('pdf')}.pdf', 'lab', convert_to('pdf', 'UTF8'), 'application/pdf', 3, '${sha('pdf')}');
      insert into asset(id, workspace_id, path, object_key, content_type, byte_size, sha256, created_by, created_at) values
        ('asset-plot', 'lab', 'books/guide/plot.png', 'lab/content/${sha('png')}/books/guide/plot.png', 'image/png', 3, '${sha('png')}', 'alice', '2026-01-02T00:00:00Z'),
        ('blob-1', 'lab', 'blob-1', 'lab/assets/blob-1/${sha('pdf')}.pdf', 'application/pdf', 3, '${sha('pdf')}', 'alice', '2026-01-02T00:00:00Z');
      insert into store_item(workspace_id, owner_id, domain, key, value, created_at, updated_at) values
        ('lab', 'alice', 'tasks', 't1', '{"title": "Write"}', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('lab', null, 'glossary', 'CRDT', '{"term": "CRDT"}', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('lab', null, 'analytics', 'views', '{"count": 9}', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
      insert into reference(id, workspace_id, citation_key, value, created_by, created_at, updated_at) values
        ('ref-1', 'lab', 'knuth1984', '{"title": "Literate Programming"}', 'alice', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
      insert into channel(id, workspace_id, kind, name, topic, created_by, created_at) values
        ('ch_general', 'lab', 'public', 'general', 'Everything', 'alice', '2026-01-01T00:00:00Z'),
        ('ch_secret', 'lab', 'private', 'secret', null, 'bob', '2026-01-01T00:00:00Z');
      insert into channel_member(workspace_id, channel_id, user_id, joined_at, last_read_seq) values
        ('lab', 'ch_general', 'alice', '2026-01-01T00:00:00Z', 1), ('lab', 'ch_general', 'vic', '2026-01-01T00:00:00Z', 0),
        ('lab', 'ch_secret', 'bob', '2026-01-01T00:00:00Z', 0);
      insert into message(id, workspace_id, seq, channel_id, user_id, body, created_at, deleted_at) values
        ('msg_1', 'lab', 1, 'ch_general', 'alice', 'hello', '2026-01-01T01:00:00Z', null),
        ('msg_2', 'lab', 2, 'ch_general', 'vic', 'gone', '2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z'),
        ('msg_3', 'lab', 1, 'ch_secret', 'bob', 'shh', '2026-01-01T01:00:00Z', null);
    `);
  });
  after(() => db?.close());

  it('writes nothing on a dry run', async () => {
    const result = await importLegacyContent(owner);
    assert.equal(result.applied, false);
    assert.equal(result.workspaces.find(each => each.workspace === 'lab').verified, true);
    assert.equal((await db.query('select count(*)::int as n from fs_node')).rows[0].n, 0);
  });

  it('imports documents with their history, privacy, trash, and assets', async () => {
    await importLegacyContent(owner, {apply: true});
    const documents = createFsDocuments({fs});
    const intro = await documents.get(as('vic'), 'books/guide/intro.md');
    assert.equal(intro.id, 'doc-intro');
    assert.equal(intro.markdown, '# Intro v3');
    assert.equal(new Date(intro.updatedAt).toISOString(), '2026-01-03T00:00:00.000Z');
    const versions = await documents.versions(as('alice'), 'books/guide/intro.md');
    assert.equal(versions.length, 3);
    assert.equal((await documents.version(as('alice'), 'books/guide/intro.md', versions.at(-1).seq)).markdown, '# Intro v1');

    assert.equal(await documents.get(as('alice'), 'journal/secret.md'), undefined);
    assert.equal((await documents.get(as('bob'), 'journal/secret.md')).markdown, 'mine');
    assert.equal(await documents.get(as('alice'), 'posts/old.md'), undefined);
    assert.ok((await fs.trash(as('alice'))).some(node => node.path === 'posts/old.md'));

    assert.equal((await fs.read(as('vic'), 'books/guide/plot.png')).body.toString(), 'png');
    assert.equal((await fs.readById(as('vic'), 'blob-1')).body.toString(), 'pdf');
    assert.equal((await fs.stat(as('vic'), 'books/guide')).kind, 'folder');
  });

  it('imports app records as files, members\' own in their private home', async () => {
    const {createFsRecords} = require('../../../../src/server/fs/records.js');
    const store = createFsRecords({fs, legacy: {collection: () => null}});
    assert.deepEqual(await store.collection('tasks').values(as('alice')), [{title: 'Write'}]);
    assert.deepEqual(await store.collection('tasks').values(as('bob')), []);
    assert.equal((await fs.stat(as('alice'), 'home/alice')).access, 'private');
    assert.deepEqual(await store.collection('glossary').get(as('vic'), 'CRDT'), {term: 'CRDT'});
    assert.deepEqual(await store.collection('plugin:bibliography:papers').get(as('vic'), 'knuth1984'), {title: 'Literate Programming'});
    assert.equal(await fs.stat(as('alice'), 'apps/analytics/views.json'), null);
  });

  it('imports chat, keeping private channels to their members', async () => {
    const {createFsChat} = require('../../../../src/server/fs/chat.js');
    const chat = createFsChat({fs});
    const {messages} = await chat.listMessages('lab', 'vic', 'ch_general');
    assert.deepEqual(messages.map(message => [message.seq, message.body]), [[1, 'hello'], [2, null]]);
    assert.equal((await chat.listChannels('lab', 'alice')).find(channel => channel.id === 'ch_general').lastReadSeq, 1);
    assert.equal(await chat.visibleChannel('lab', 'alice', 'ch_secret'), null);
    assert.equal((await chat.listMessages('lab', 'bob', 'ch_secret')).messages[0].body, 'shh');
    assert.deepEqual(await chat.createChannel('lab', 'alice', {name: 'general'}), {error: 'name-taken'});
  });

  it('skips a workspace that already has files unless asked to replace it', async () => {
    const again = await importLegacyContent(owner, {apply: true});
    assert.match(again.workspaces.find(each => each.workspace === 'lab').skipped, /already has/);
    await db.exec("update document set markdown = '# Intro v4' where id = 'doc-intro'");
    await importLegacyContent(owner, {apply: true, replace: true});
    const intro = await createFsDocuments({fs}).get(as('alice'), 'books/guide/intro.md');
    assert.equal(intro.markdown, '# Intro v4');
  });
});
