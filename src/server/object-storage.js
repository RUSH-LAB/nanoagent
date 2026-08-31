const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {VAR_DIR} = require('./paths');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encodePath = value => String(value).split('/').map(encodeURIComponent).join('/');

function localObjectStorage({root = path.join(VAR_DIR, 'objects'), files = fs} = {}) {
  const target = key => path.join(root, ...String(key).split('/').filter(Boolean));
  return Object.freeze({
    provider: 'local',
    root,
    async put(key, body) {
      const file = target(key);
      files.mkdirSync(path.dirname(file), {recursive: true});
      const temporary = `${file}.${process.pid}.tmp`;
      files.writeFileSync(temporary, body);
      files.renameSync(temporary, file);
    },
    async get(key) {
      try { return Buffer.from(files.readFileSync(target(key))); } catch { return null; }
    },
    async stat(key) {
      try { const value = files.statSync(target(key)); return {size: value.size, mtimeMs: value.mtimeMs}; } catch { return null; }
    },
    async remove(key) {
      try { files.unlinkSync(target(key)); return true; } catch { return false; }
    },
  });
}

function s3ObjectStorage({endpoint, bucket, region = 'auto', accessKeyId, secretAccessKey, fetchImpl = fetch}) {
  if (![endpoint, bucket, accessKeyId, secretAccessKey].every(Boolean)) throw new Error('Incomplete object storage configuration');
  const base = String(endpoint).replace(/\/+$/, '');

  async function request(method, key, {body, headers = {}} = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payload = body == null ? Buffer.alloc(0) : Buffer.from(body);
    const payloadHash = hash(payload);
    const url = new URL(`${base}/${encodeURIComponent(bucket)}/${encodePath(key)}`);
    const signed = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const canonicalHeaders = Object.entries(signed).map(([name, value]) => `${name}:${value}\n`).join('');
    const signedHeaders = Object.keys(signed).join(';');
    const canonical = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
    const dateKey = hmac(`AWS4${secretAccessKey}`, date);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return fetchImpl(url, {method, body: body == null ? undefined : payload, headers: {...headers, ...signed, Authorization: authorization}});
  }

  return Object.freeze({
    provider: 's3',
    async put(key, body, contentType = 'application/octet-stream') {
      const response = await request('PUT', key, {body, headers: {'Content-Type': contentType}});
      if (!response.ok) throw new Error(`Object upload failed (${response.status})`);
    },
    async get(key) {
      const response = await request('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Object download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },
    async stat(key) {
      const response = await request('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Object stat failed (${response.status})`);
      return {size: Number(response.headers.get('content-length') || 0), etag: response.headers.get('etag')};
    },
    async remove(key) {
      const response = await request('DELETE', key);
      return response.ok || response.status === 404;
    },
  });
}

function createObjectStorage(env = process.env, options = {}) {
  const configured = env.OBJECT_STORAGE_ENDPOINT || env.OBJECT_STORAGE_BUCKET;
  if (configured) return s3ObjectStorage({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    bucket: env.OBJECT_STORAGE_BUCKET,
    region: env.OBJECT_STORAGE_REGION || 'auto',
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    fetchImpl: options.fetchImpl,
  });
  if (env.NODE_ENV === 'production') throw new Error('Production requires S3/R2 object storage configuration');
  return localObjectStorage(options);
}

module.exports = {createObjectStorage, localObjectStorage, s3ObjectStorage};
