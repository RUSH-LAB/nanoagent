import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv} from '../../../scripts/db/postgres.mjs';

describe('.env parser', () => {
  it('loads direct and pooled Neon URLs without shell evaluation', () => {
    const values = parseEnv(`
      DATABASE_MIGRATION_URL='postgresql://owner:p%40ss@direct.example/neondb?sslmode=require'
      DATABASE_URL="postgresql://mochi_runtime:p%24ss@pooled.example/neondb?sslmode=require"
      PG_SSL=require
    `);
    assert.deepEqual(values, {
      DATABASE_MIGRATION_URL: 'postgresql://owner:p%40ss@direct.example/neondb?sslmode=require',
      DATABASE_URL: 'postgresql://mochi_runtime:p%24ss@pooled.example/neondb?sslmode=require',
      PG_SSL: 'require',
    });
  });

  it('ignores comments and supports export-prefixed values', () => {
    assert.deepEqual(parseEnv('# dev only\nexport PG_SSL=disable\n'), {PG_SSL: 'disable'});
  });

  it('rejects a wrapped or malformed connection line', () => {
    assert.throws(() => parseEnv('DATABASE_URL=postgresql://direct-\nhost/neondb?sslmode=require'), /Invalid environment line/);
  });
});
