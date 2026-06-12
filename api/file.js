// Vercel serverless function: GET /api/file?path=..., PUT /api/file, POST /api/file
// Reads, writes, and creates files via the GitHub Contents API.

const { getFile, putFile, deleteFile, isValidFilePath, jsonResponse, optionsResponse } = require('./_github');

module.exports = async function handler(req) {
  if (req.method === 'OPTIONS') return optionsResponse();

  // ── GET: read a file ──
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) {
      return jsonResponse(400, { error: 'Invalid path' });
    }
    try {
      const data = await getFile(filePath);
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return jsonResponse(200, { content });
    } catch (err) {
      if (err.status === 404) {
        return jsonResponse(404, { error: 'File not found' });
      }
      return jsonResponse(500, { error: err.message });
    }
  }

  // ── PUT: update an existing file ──
  if (req.method === 'PUT') {
    try {
      const body = await req.json();
      const { path: filePath, content } = body;
      if (!isValidFilePath(filePath)) {
        return jsonResponse(400, { error: 'Invalid path' });
      }
      if (typeof content !== 'string') {
        return jsonResponse(400, { error: 'Content must be a string' });
      }

      // Fetch current file to get its sha (required for update).
      let existing;
      try {
        existing = await getFile(filePath);
      } catch (err) {
        if (err.status === 404) {
          return jsonResponse(404, { error: 'File not found' });
        }
        throw err;
      }

      await putFile(filePath, content, `Update ${filePath}`, existing.sha);
      return jsonResponse(200, { success: true });
    } catch (err) {
      return jsonResponse(500, { error: err.message });
    }
  }

  // ── POST: create a new file ──
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { path: filePath, content } = body;
      if (!isValidFilePath(filePath)) {
        return jsonResponse(400, { error: 'Invalid path' });
      }
      if (typeof content !== 'string') {
        return jsonResponse(400, { error: 'Content must be a string' });
      }

      // Check if file already exists.
      try {
        await getFile(filePath);
        return jsonResponse(409, { error: 'File already exists' });
      } catch (err) {
        if (err.status !== 404) throw err;
        // 404 is expected -- file does not exist, we can create it.
      }

      await putFile(filePath, content, `Create ${filePath}`);
      return jsonResponse(200, { success: true, path: filePath });
    } catch (err) {
      return jsonResponse(500, { error: err.message });
    }
  }

  // ── DELETE: delete a file ──
  if (req.method === 'DELETE') {
    const url = new URL(req.url, 'http://localhost');
    const filePath = url.searchParams.get('path');
    if (!isValidFilePath(filePath)) {
      return jsonResponse(400, { error: 'Invalid path' });
    }
    try {
      let existing;
      try {
        existing = await getFile(filePath);
      } catch (err) {
        if (err.status === 404) {
          return jsonResponse(404, { error: 'File not found' });
        }
        throw err;
      }
      await deleteFile(filePath, existing.sha, `Delete ${filePath}`);
      return jsonResponse(200, { success: true });
    } catch (err) {
      return jsonResponse(500, { error: err.message });
    }
  }

  return jsonResponse(405, { error: 'Method not allowed' });
};
