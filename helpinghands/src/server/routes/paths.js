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

// A member's benchmark publication (benchmark.js), and the benchmark worker's API, which has no member session (benchmark-worker.js).
const BENCHMARK_PUBLISH_ROUTE = /^\/api\/benchmark\/benchmarks$/;
// A member's worker credentials (benchmark.js), which belong to the member and no workspace.
const BENCHMARK_CREDENTIAL_ROUTE = /^\/api\/benchmark\/worker-credentials(?:\/[^/]+)?$/;
const BENCHMARK_WORKER_ROUTE = /^\/api\/benchmark-worker\/.+$/;
// A member's traces, or for a platform administrator every member's, from all their workspaces (trace-export.js).
const TRACE_EXPORT_ROUTE = /^\/api\/traces\/(?:export|workspaces\/[^/]+)$/;

module.exports = {MARKET_ROUTE, LAB_ROUTE, APP_UI_ROUTE, BENCHMARK_PUBLISH_ROUTE, BENCHMARK_CREDENTIAL_ROUTE, BENCHMARK_WORKER_ROUTE, TRACE_EXPORT_ROUTE};
