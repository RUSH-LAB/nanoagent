export function isKnownTestDocumentPath(path) {
  return [
    /^__test_snapshot_\d+\.md$/,
    /^books\/__test_\d+_post\.md$/,
    /^posts\/__resilience_\d+_stress\.md$/,
    /^posts\/wftest-\d+_(?:data_a|research_post|sched_target|snap_target)\.md$/,
    /^posts\/blog\/\d{4}-\d{2}-\d{2}-test-\d+-rate-limit\.md$/,
    /^posts\/blog\/\d{4}-\d{2}-\d{2}-resilience-\d+-stress-(?:ratelimit(?:_[0-9a-f]{12})?|unicode)\.md$/,
    /^should-not-exist\.md$/,
  ].some(pattern => pattern.test(String(path || '')));
}
