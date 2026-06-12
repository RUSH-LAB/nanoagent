// Vercel serverless function: POST /api/file/rename
// Renames a file by reading the old file, creating the new one, then deleting the old one.

const { getFile, putFile, deleteFile, isValidFilePath, jsonResponse, optionsResponse } = require('./_github');

module.exports = async function handler(req) {
  if (req.method === 'OPTIONS') return optionsResponse();

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const body = await req.json();
    const { oldPath, newPath } = body;

    if (!isValidFilePath(oldPath) || !isValidFilePath(newPath)) {
      return jsonResponse(400, { error: 'Invalid path' });
    }

    // Read old file content and sha.
    let oldFile;
    try {
      oldFile = await getFile(oldPath);
    } catch (err) {
      if (err.status === 404) {
        return jsonResponse(404, { error: 'Source not found' });
      }
      throw err;
    }

    // Check that the target does not already exist.
    try {
      await getFile(newPath);
      return jsonResponse(409, { error: 'Target already exists' });
    } catch (err) {
      if (err.status !== 404) throw err;
      // 404 is expected.
    }

    // Decode content from old file.
    const content = Buffer.from(oldFile.content, 'base64').toString('utf-8');

    // Create new file.
    await putFile(newPath, content, `Rename ${oldPath} to ${newPath}`);

    // Delete old file.
    await deleteFile(oldPath, oldFile.sha, `Rename ${oldPath} to ${newPath} (delete old)`);

    return jsonResponse(200, { success: true, path: newPath });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
