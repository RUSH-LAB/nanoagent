const database = require('./database');
const {createPostgresStore} = require('./store');
const {createPostgresSettings, createPostgresPreferences, createPostgresAssets} = require('./settings');
const {createPostgresWorkspaceContextResolver} = require('./workspace-context');
const {createPostgresOrg} = require('./org');
const {createPostgresRoles} = require('./roles');
const {createPostgresMarket} = require('./market');
const {createPostgresSessions} = require('./sessions');
const {createPostgresWorkspacePlugins} = require('./workspace-plugins');
const {createPostgresMemberKeys} = require('./member-keys');
const {createObjectDeletionQueue} = require('../object-deletions');
const {auth, tenancy, workspaceProvisioning, AUTH_SECRET} = require('../auth');
const {createPostgresFs, createPublicFsReader} = require('../fs/store');
const {createFsDocuments} = require('../fs/documents');
const {createFsAssetStore} = require('../fs/assets');
const {createCrdt} = require('../fs/crdt');
const {createFsHub} = require('../fs/events');
const {createFsRecords} = require('../fs/records');
const {createFsChat} = require('../fs/chat');

if (!database.pool) throw new Error('PostgreSQL services require DATABASE_URL');

// Documents, uploads, app records, and chat live in the workspace file system
// (docs/plans/workspace-filesystem.md); `npm run fs:import` copies the original
// tables into it.
const fs = createPostgresFs({pool: database.pool, onChange: workspaceId => fsHub.changed(workspaceId)});
const fsHub = createFsHub({fs});
const legacyStore = createPostgresStore({pool: database.pool});
const fsChat = createFsChat({fs});

module.exports = Object.freeze({
  ready: database.ready,
  close: database.close,
  pool: database.pool,
  // App records become files; internal state stays in the legacy store.
  store: createFsRecords({fs, legacy: legacyStore}),
  fs,
  publicFs: createPublicFsReader({pool: database.pool}),
  documents: createFsDocuments({fs}),
  assetStore: createFsAssetStore({fs}),
  crdt: createCrdt({fs}),
  fsHub,
  workspaceSettings: createPostgresSettings({pool: database.pool}),
  preferences: createPostgresPreferences({pool: database.pool}),
  assets: createPostgresAssets({pool: database.pool}),
  workspaceContexts: createPostgresWorkspaceContextResolver({pool: database.pool}),
  org: createPostgresOrg({
    pool: database.pool, auth, removeMemberChannels: workspaceProvisioning.hooks.beforeRemoveMember,
  }),
  tenancy,
  chat: fsChat,
  fsChat,
  roles: createPostgresRoles({pool: database.pool}),
  market: createPostgresMarket({pool: database.pool}),
  sessions: createPostgresSessions({pool: database.pool}),
  workspacePlugins: createPostgresWorkspacePlugins({pool: database.pool}),
  memberKeys: createPostgresMemberKeys({pool: database.pool, secret: AUTH_SECRET}),
  objectDeletions: createObjectDeletionQueue({pool: database.pool}),
});
