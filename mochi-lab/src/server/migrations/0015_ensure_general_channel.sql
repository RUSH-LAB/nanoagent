-- Every active workspace has one visible #general, and every current member is
-- joined to it. New workspaces already get this through provisioning; this
-- migration brings older workspaces up to the same product invariant.

UPDATE channel
   SET archivedAt = NULL
 WHERE kind = 'public' AND name = 'general';

INSERT OR IGNORE INTO channel
  (id, organizationId, kind, name, topic, dmKey, createdBy, createdAt, archivedAt)
SELECT
  'ch_' || lower(hex(randomblob(12))),
  o.id,
  'public',
  'general',
  'Everything, to start with',
  NULL,
  (SELECT m.userId FROM member m WHERE m.organizationId = o.id ORDER BY m.createdAt LIMIT 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM organization o
WHERE o.status = 'active'
  AND EXISTS (SELECT 1 FROM member m WHERE m.organizationId = o.id)
  AND NOT EXISTS (
    SELECT 1 FROM channel c
     WHERE c.organizationId = o.id AND c.kind = 'public' AND c.name = 'general'
  );

INSERT OR IGNORE INTO channel_member (channelId, userId, joinedAt, lastReadSeq)
SELECT c.id, m.userId, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
FROM channel c
JOIN member m ON m.organizationId = c.organizationId
WHERE c.kind = 'public' AND c.name = 'general' AND c.archivedAt IS NULL;
