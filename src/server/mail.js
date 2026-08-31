/** Transactional email through a deployment-provided HTTPS webhook. */
async function sendMail({to, template, subject, url, data = {}}) {
  const endpoint = process.env.MAIL_WEBHOOK_URL;
  if (!endpoint) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MAIL_WEBHOOK_URL is required to send account email');
    }
    return {delivered: false, development: true};
  }

  const target = new URL(endpoint);
  if (target.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('MAIL_WEBHOOK_URL must use HTTPS in production');
  }
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.MAIL_WEBHOOK_TOKEN
        ? {Authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}`}
        : {}),
    },
    body: JSON.stringify({to, template, subject, url, data}),
  });
  if (!response.ok) throw new Error(`Mail delivery failed (${response.status})`);
  return {delivered: true};
}

module.exports = {sendMail};
