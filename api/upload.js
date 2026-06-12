// Vercel serverless function: POST /api/upload
// Uploads an image to the GitHub repo under static/img/uploads/.

const { getFile, getConfig, jsonResponse, optionsResponse, headers, GITHUB_API } = require('./_github');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

module.exports = async function handler(req) {
  if (req.method === 'OPTIONS') return optionsResponse();

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const targetDir = url.searchParams.get('dir') || 'static/img/uploads';
    const fileName = url.searchParams.get('name');

    if (!fileName) {
      return jsonResponse(400, { error: 'Missing file name' });
    }

    // Validate extension.
    const ext = '.' + fileName.split('.').pop().toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) {
      return jsonResponse(400, { error: 'Invalid image type' });
    }

    // Validate directory: reject traversal and absolute paths, and confine
    // uploads to the static/img/ area.
    if (targetDir.includes('..') || targetDir.startsWith('/') || !targetDir.startsWith('static/img/')) {
      return jsonResponse(400, { error: 'Invalid directory' });
    }

    // Sanitize file name.
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `${targetDir}/${safeName}`;

    // Read raw binary body.
    const arrayBuffer = await req.arrayBuffer();
    const base64Content = Buffer.from(arrayBuffer).toString('base64');

    // Check if file exists to get sha for overwrite.
    let sha;
    try {
      const existing = await getFile(filePath);
      sha = existing.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
      // File does not exist yet, that is fine.
    }

    // Upload via GitHub Contents API (putFile expects string content,
    // but for binary we need to send base64 directly).
    const { token, repo, branch } = getConfig();
    const apiUrl = `${GITHUB_API}/repos/${repo}/contents/${filePath}`;
    const body = {
      message: `Upload image ${safeName}`,
      content: base64Content,
      branch,
    };
    if (sha) body.sha = sha;

    const res = await fetch(apiUrl, {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return jsonResponse(500, { error: errData.message || 'Upload failed' });
    }

    // Build public URL path (relative to static/).
    const publicPath = '/' + filePath.replace(/^static\//, '');
    return jsonResponse(200, { success: true, url: publicPath });
  } catch (err) {
    return jsonResponse(500, { error: 'Upload failed: ' + err.message });
  }
};
