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

if (!database.pool) throw new Error('PostgreSQL services require DATABASE_URL');

module.exports = Object.freeze({
  ready: database.ready,
  close: database.close,
  pool: database.pool,
  store: createPostgresStore({pool: database.pool}),
  documents: createPostgresDocuments({pool: database.pool}),
  workspaceSettings: createPostgresSettings({pool: database.pool}),
  preferences: createPostgresPreferences({pool: database.pool}),
  assets: createPostgresAssets({pool: database.pool}),
  workspaceContexts: createPostgresWorkspaceContextResolver({pool: database.pool}),
  org: createPostgresOrg({pool: database.pool, auth}),
  chat: createPostgresChat({pool: database.pool}),
  roles: createPostgresRoles({pool: database.pool}),
  objectDeletions: createObjectDeletionQueue({pool: database.pool}),
});
