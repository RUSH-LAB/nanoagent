class NoIdentityError extends Error {
  constructor() {
    super('Preferences require a signed-in user');
    this.status = 401;
    this.code = 'no-identity';
  }
}

function createPreferences({db = require('./db').db, now = () => new Date().toISOString()} = {}) {
  const getRow = db.prepare('SELECT "value" FROM user_preferences WHERE "userId" = ?');
  const putRow = db.prepare(`
    INSERT INTO user_preferences ("userId", "value", "updatedAt") VALUES (?, ?, ?)
    ON CONFLICT ("userId") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"
  `);
  const userIdOf = userId => {
    if (!userId || typeof userId !== 'string') throw new NoIdentityError();
    return userId;
  };
  const get = userId => {
    const row = getRow.get(userIdOf(userId));
    return row ? JSON.parse(row.value) : {};
  };
  const set = (userId, value) => {
    const id = userIdOf(userId);
    const updatedAt = value?.updatedAt ?? now();
    putRow.run(id, JSON.stringify(value ?? {}), updatedAt);
    return value ?? {};
  };
  const merge = (userId, patch) => db.transaction(() => {
    const next = {...get(userId), ...patch, updatedAt: now()};
    return set(userId, next);
  })();
  return {get, set, merge};
}

module.exports = {...createPreferences(), createPreferences, NoIdentityError};
