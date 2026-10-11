'use strict';

const MAX_INPUT = 40_000;
const FORBIDDEN_SOURCE = /(?:#eval|#run|run_cmd|run_tac|\belab\b|\bmacro\b|\bsyntax\b|\bunsafe\b|\baxiom\b|\badmit\b|\bsorry\b|\bextern\b)/;

function localExecutionAllowed(req, env = process.env) {
  if (env.LEAN_PROOFS_ALLOW_EXEC === 'true') return true;
  if (env.NODE_ENV === 'production') return false;
  const address = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ['127.0.0.1', '::1'].includes(address);
}

function cleanLean(text) {
  return String(text ?? '')
    .trim()
    .replace(/^```(?:lean4?|Lean4?)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function formalizationPrompt(statement, proof) {
  return [
    'Formalize the following mathematical theorem and proof in Lean 4.',
    'Return only a complete Lean source file, with imports and no Markdown fences.',
    'Prefer readable named lemmas and tactics. Do not use sorry, admit, axiom, or unsafe.',
    'The source will be checked in a Lake project with Mathlib available.',
    '',
    'Theorem statement:',
    statement,
    '',
    'Informal proof:',
    proof || '(No informal proof was supplied.)',
  ].join('\n');
}

module.exports = async function leanProofRoutes(req, res, _url, pathname, api) {
  if (req.method === 'GET' && pathname === '/api/lean-proofs/status') {
    if (!localExecutionAllowed(req)) {
      return api.respond(res, 200, {available: false, reason: 'Local Lean execution is disabled', ai: api.ai.describe()});
    }
    req.setTimeout?.(30_000);
    const lean = await api.exec('lake', ['env', 'lean', '--version'], {cwd: 'proofs', timeoutMs: 25_000});
    return api.respond(res, 200, {
      available: lean.ok,
      lean: (lean.stdout || lean.stderr).trim(),
      timedOut: lean.timedOut,
      ai: api.ai.describe(),
    });
  }

  if (req.method === 'POST' && pathname === '/api/lean-proofs/formalize') {
    if (!await api.rateLimit(`formalize:${api.caller.userId || 'anonymous'}`, 6)) {
      return api.respond(res, 429, {error: 'Too many formalization requests. Try again in a minute.'});
    }
    let body;
    try { body = await api.readBody(); } catch { return api.respond(res, 400, {error: 'Invalid JSON body'}); }
    const statement = api.sanitize(body?.statement);
    const proof = api.sanitize(body?.proof);
    if (!statement.trim()) return api.respond(res, 400, {error: 'A theorem statement is required'});
    if (statement.length + proof.length > MAX_INPUT) return api.respond(res, 400, {error: 'Proof input is too large'});

    req.setTimeout?.(90_000);
    const result = await api.ai.complete({
      system: 'You are an expert Lean 4 and Mathlib formalizer. Produce compilable code only.',
      prompt: formalizationPrompt(statement, proof),
    });
    if (result.error) return api.respond(res, result.status || 502, {error: result.error});
    return api.respond(res, 200, {source: cleanLean(result.text), verified: false});
  }

  if (req.method === 'POST' && pathname === '/api/lean-proofs/check') {
    if (!localExecutionAllowed(req)) {
      return api.respond(res, 403, {error: 'Local Lean execution is available only on loopback development servers'});
    }
    if (!await api.rateLimit(`check:${api.caller.userId || 'anonymous'}`, 20)) {
      return api.respond(res, 429, {error: 'Too many Lean checks. Try again in a minute.'});
    }
    let body;
    try { body = await api.readBody(); } catch { return api.respond(res, 400, {error: 'Invalid JSON body'}); }
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!source.trim()) return api.respond(res, 400, {error: 'Lean source is required'});
    if (source.length > MAX_INPUT) return api.respond(res, 400, {error: 'Lean source is too large'});
    if (FORBIDDEN_SOURCE.test(source)) {
      return api.respond(res, 400, {error: 'The checker refuses placeholders and executable metaprogramming commands'});
    }

    req.setTimeout?.(180_000);
    const result = await api.exec('lake', ['env', 'lean', '--stdin', '--timeout=400000'], {
      cwd: 'proofs',
      input: source,
      timeoutMs: 180_000,
      maxBytes: 1024 * 1024,
    });
    return api.respond(res, 200, {
      verified: result.ok,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });
  }
};

module.exports.cleanLean = cleanLean;
module.exports.formalizationPrompt = formalizationPrompt;
module.exports.localExecutionAllowed = localExecutionAllowed;
