const database = require('./database');
const {createPostgresStore} = require('./store');
const {createPostgresDocuments} = require('./documents');
const {createPostgresSettings, createPostgresPreferences, createPostgresAssets} = require('./settings');
const {createPostgresWorkspaceContextResolver} = require('./workspace-context');
const {createPostgresOrg} = require('./org');
const {createPostgresChat} = require('./chat');
const {createPostgresRoles} = require('./roles');
const {createObjectDeletionQueue} = require('../object-deletions');
const {auth} = require('../auth');
const {createPostgresFs, createPublicFsReader} = require('../fs/store');
const {createFsDocuments} = require('../fs/documents');
const {createFsAssetStore} = require('../fs/assets');

if (!database.pool) throw new Error('PostgreSQL services require DATABASE_URL');

// Which store serves documents and uploads: the original tables (`legacy`) or
// the workspace file system (`fs`, docs/plans/workspace-filesystem.md). Both
// stay in the schema; `npm run fs:import` copies the first into the second.
const CONTENT_STORES = Object.freeze(['legacy', 'fs']);
const contentStore = process.env.CONTENT_STORE || 'legacy';
if (!CONTENT_STORES.includes(contentStore)) {
  throw new Error(`CONTENT_STORE must be one of ${CONTENT_STORES.join(', ')}, not "${contentStore}"`);
}
const fs = contentStore === 'fs' ? createPostgresFs({pool: database.pool}) : null;

module.exports = Object.freeze({
  ready: database.ready,
  close: database.close,
  pool: database.pool,
  store: createPostgresStore({pool: database.pool}),
  contentStore,
  fs,
  publicFs: fs ? createPublicFsReader({pool: database.pool}) : null,
  documents: fs ? createFsDocuments({fs}) : createPostgresDocuments({pool: database.pool}),
  assetStore: fs ? createFsAssetStore({fs}) : null,
  workspaceSettings: createPostgresSettings({pool: database.pool}),
  preferences: createPostgresPreferences({pool: database.pool}),
  assets: createPostgresAssets({pool: database.pool}),
  workspaceContexts: createPostgresWorkspaceContextResolver({pool: database.pool}),
  org: createPostgresOrg({pool: database.pool, auth}),
  chat: createPostgresChat({pool: database.pool}),
  roles: createPostgresRoles({pool: database.pool}),
  objectDeletions: createObjectDeletionQueue({pool: database.pool}),
});
