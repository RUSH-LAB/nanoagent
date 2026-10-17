'use strict';
const crypto = require('crypto');

// What one chunk row holds: a bundle goes in and out this much at a time.
const CHUNK_BYTES = 4 * 1024 * 1024;

const refusal = (status, message) => Object.assign(new Error(message), {status});

/**
 * RUSH Lab's bundles (migrations 0034, 0039): the newest dmg for each target,
 * which anyone may download and only the upload path writes. Neither
 * direction holds a whole bundle: an upload is written chunk by chunk as its
 * body arrives, and a download reads one chunk at a time.
 */
function createPostgresLab({pool}) {
  // Its first row, as the runtime role: anyone reads the bundles (migration 0039).
  const first = async (sql, params) => {
    const client = await pool.connect();
    try {
      return (await client.query(sql, params)).rows[0];
    } finally {
      client.release();
    }
  };

  return Object.freeze({
    /** The target's bundle, without its bytes, or null. */
    async bundle(target) {
      const row = await first('select target, upload_id, stamp, sha256, size from lab_bundle where target = $1', [target]);
      return row ? {target: row.target, uploadId: row.upload_id, stamp: row.stamp, sha256: row.sha256, size: Number(row.size)} : null;
    },
    /**
     * The bytes of `bundle`, one chunk at a time. An upload that replaces it
     * meanwhile takes its chunks, so the rest is missing, which throws.
     */
    async* chunks(bundle) {
      const fetch = seq => first('select data from lab_bundle_chunk where upload_id = $1 and seq = $2', [bundle.uploadId, seq]);
      const count = Math.ceil(bundle.size / CHUNK_BYTES);
      // The next chunk is read while this one is sent, so the database's round trip is not added to each.
      let next = count > 0 ? fetch(0) : null;
      try {
        for (let seq = 0; seq < count; seq++) {
          const row = await next;
          next = seq + 1 < count ? fetch(seq + 1) : null;
          if (!row) throw new Error(`The ${bundle.target} bundle was replaced while it was being sent`);
          yield Buffer.from(row.data);
        }
      } finally {
        // A download stopped early (an error, or the client gone) waits for the read it started.
        await next?.catch(() => {});
      }
    },
    /**
     * Store `body`, an async iterable of buffers, as the target's bundle,
     * replacing the one before: in one transaction, so a failed upload leaves
     * that one. Refuses a body over `maxBytes` (413) or an empty one (400).
     */
    async replace(target, stamp, body, maxBytes) {
      const client = await pool.connect();
      try {
        await client.query("begin; select set_config('app.lab_upload', 'on', true)");
        const uploadId = crypto.randomUUID();
        const hash = crypto.createHash('sha256');
        let size = 0;
        let seq = 0;
        let pending = [];
        let pendingBytes = 0;
        const flush = async () => {
          await client.query('insert into lab_bundle_chunk(upload_id, seq, data) values ($1, $2, $3)', [uploadId, seq++, Buffer.concat(pending)]);
          pending = [];
          pendingBytes = 0;
        };
        for await (const piece of body) {
          size += piece.length;
          if (size > maxBytes) throw refusal(413, `A bundle may be ${maxBytes / 1024 / 1024} MB at most`);
          hash.update(piece);
          for (let offset = 0; offset < piece.length;) {
            const take = Math.min(CHUNK_BYTES - pendingBytes, piece.length - offset);
            pending.push(piece.subarray(offset, offset + take));
            pendingBytes += take;
            offset += take;
            if (pendingBytes === CHUNK_BYTES) await flush();
          }
        }
        if (pendingBytes > 0) await flush();
        if (size === 0) throw refusal(400, 'The body is the bundle, and it is empty');
        const sha256 = hash.digest('hex');
        await client.query('delete from lab_bundle where target = $1', [target]);
        await client.query(
          'insert into lab_bundle(target, upload_id, stamp, sha256, size) values ($1, $2, $3, $4, $5)',
          [target, uploadId, stamp, sha256, size],
        );
        await client.query('commit');
        return {target, stamp, sha256, size};
      } catch (error) {
        try { await client.query('rollback'); } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

module.exports = {createPostgresLab, CHUNK_BYTES};
