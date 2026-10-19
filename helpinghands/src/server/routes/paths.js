'use strict';

/**
 * The API routes that answer outside any workspace, each matched by one pattern here: the route
 * that serves it matches its requests with it, and the workspace gate (workspace-context.js) lets
 * the same requests through, so no route can be served and refused at once.
 */

// The marketplace (market.js): every plugin, one plugin, its package, and its source on GitHub.
const MARKET_ROUTE = /^\/api\/market(?:\/([^/]+)(?:\/(package|source))?)?$/;
// RUSH Lab's connect link, session, sign-in, downloads and updates (lab.js).
const LAB_ROUTE = /^\/api\/lab\/(?:(connect)|(session)|(sign-in)|(window-sign-in)|bundles\/([^/]+)|updates\/([^/]+)(\/app\.tar\.gz)?|(engine)(\/engine\.tar\.gz)?|(releases))$/;
// A plugin's page, from whichever workspace opens it (apps.js).
const APP_UI_ROUTE = /^\/api\/apps\/([^/]+)\/ui\/([^/]+)\/([^/]+)\/(.+)$/;

module.exports = {MARKET_ROUTE, LAB_ROUTE, APP_UI_ROUTE};
