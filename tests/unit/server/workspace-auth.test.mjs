import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const {organizationOptions, postgresOrganizationSchema} = require('../../../src/server/workspace-auth.js');

describe('Better Auth workspace ownership', () => {
  it('maps Better Auth organization models onto the PostgreSQL workspace schema', () => {
    const options = organizationOptions({postgresEnabled: true});
    assert.equal(options.schema, postgresOrganizationSchema);
    assert.equal(options.schema.organization.modelName, 'workspace');
    assert.equal(options.schema.member.modelName, 'workspace_member');
    assert.equal(options.schema.invitation.modelName, 'workspace_invitation');
    assert.equal(options.schema.member.fields.organizationId, 'workspace_id');
    assert.equal(options.schema.invitation.fields.inviterId, 'invited_by');
  });

  it('uses Better Auth defaults for SQLite and blocks its unsafe hard-delete endpoint', () => {
    const hooks = {afterAddMember() {}};
    const options = organizationOptions({hooks});
    assert.equal(options.schema, undefined);
    assert.equal(options.organizationHooks, hooks);
    assert.equal(options.creatorRole, 'owner');
    assert.equal(options.disableOrganizationDeletion, true);
    assert.equal(options.cancelPendingInvitationsOnReInvite, true);
  });

  it('does not retain a second PostgreSQL membership or invitation writer', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/postgres/org.js'), 'utf8');
    assert.match(source, /auth\.api\.createOrganization/);
    assert.match(source, /auth\.api\.createInvitation/);
    assert.match(source, /auth\.api\.acceptInvitation/);
    assert.match(source, /auth\.api\.updateMemberRole/);
    assert.match(source, /auth\.api\.removeMember/);
    assert.doesNotMatch(source, /insert into workspace_member/i);
    assert.doesNotMatch(source, /insert into workspace_invitation/i);
    assert.doesNotMatch(source, /update workspace_member set role/i);
    assert.doesNotMatch(source, /delete from workspace_member/i);
    assert.doesNotMatch(source, /create_workspace_with_owner/);
    assert.doesNotMatch(source, /accept_workspace_invitation/);
  });
});
