function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function messageHtml({subject, url}) {
  const safeSubject = escapeHtml(subject);
  const safeUrl = escapeHtml(url);
  return `<p>${safeSubject}</p><p><a href="${safeUrl}">${safeSubject}</a></p>`;
}

async function deliveryError(response, provider) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.message || body?.error?.message || body?.name || '';
  } catch {
    // Some webhook providers return an empty or non-JSON error response.
  }
  return new Error(`${provider} delivery failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

/** Transactional email through Resend or a deployment-provided HTTPS webhook. */
async function sendMail({to, template, subject, url, data = {}}, {env = process.env, fetchImpl = fetch} = {}) {
  if (env.RESEND_API_KEY || env.MAIL_FROM) {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
      throw new Error('RESEND_API_KEY and MAIL_FROM must be configured together');
    }
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        subject,
        html: messageHtml({subject, url}),
        text: `${subject}\n\n${url}`,
        tags: [{name: 'template', value: template}],
      }),
    });
    if (!response.ok) throw await deliveryError(response, 'Resend');
    return {delivered: true, provider: 'resend'};
  }

  const endpoint = env.MAIL_WEBHOOK_URL;
  if (!endpoint) {
    if (env.NODE_ENV === 'production') {
      throw new Error('RESEND_API_KEY/MAIL_FROM or MAIL_WEBHOOK_URL is required to send account email');
    }
    return {delivered: false, development: true};
  }

  const target = new URL(endpoint);
  if (target.protocol !== 'https:' && env.NODE_ENV === 'production') {
    throw new Error('MAIL_WEBHOOK_URL must use HTTPS in production');
  }
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.MAIL_WEBHOOK_TOKEN
        ? {Authorization: `Bearer ${env.MAIL_WEBHOOK_TOKEN}`}
        : {}),
    },
    body: JSON.stringify({to, template, subject, url, data}),
  });
  if (!response.ok) throw await deliveryError(response, 'Mail');
  return {delivered: true, provider: 'webhook'};
}

module.exports = {sendMail, escapeHtml, messageHtml, deliveryError};
