'use strict';

/**
 * Deployment-owned identity for the shared application shell.
 *
 * This is intentionally separate from workspace branding. A deployment has
 * one product name used before a URL workspace resolves and in account-level
 * messages. Each workspace title, tagline, logo, and navigation still comes
 * from its validated `workspace_settings` row.
 */
function platformConfig(env = process.env) {
  return Object.freeze({
    name: env.PLATFORM_NAME?.trim() || 'RUSH Lab',
    tagline: env.PLATFORM_TAGLINE?.trim() || 'Collaborative knowledge workspaces',
  });
}

module.exports = {platformConfig};
