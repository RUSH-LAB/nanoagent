export const PROFILE_CATALOG = Object.freeze({
  defaultProfile: 'native-fast',
  profiles: [
    {id: 'native-fast', label: 'Fast · NanoAgent', harness: 'native', model: 'fast', available: true},
    {id: 'native-smart', label: 'Smart · NanoAgent', harness: 'native', model: 'smart', available: true},
    {id: 'hermes-fast', label: 'Fast · Hermes Agent', harness: 'hermes', model: 'fast', available: true},
    {id: 'hermes-smart', label: 'Smart · Hermes Agent', harness: 'hermes', model: 'smart', available: true},
    {id: 'pi-fast', label: 'Fast · PI', harness: 'pi', model: 'fast', available: false, unavailableReason: 'PI runner is not installed'},
  ],
});

export function makeCtx(options = {}) {
  const target = options.target === undefined
    ? {chatId: 'chat-1', agentId: 'mochi', label: 'Chat'}
    : options.target;
  const profileCatalog = options.profileCatalog ?? PROFILE_CATALOG;
  const agent = options.agent ?? {id: 'mochi', name: 'Mochi', profileId: 'native-fast'};
  const chatItem = options.chatItem === undefined
    ? (target?.chatId ? {id: target.chatId, agentId: target.agentId, profileId: 'native-fast'} : null)
    : options.chatItem;
  const log = {notes: [], fails: [], calls: []};
  return {
    log,
    ctx: {
      session: {id: options.sessionId ?? 's1', target},
      sessions: {
        setChatProfile: (chatId, profileId) => log.calls.push(['setChatProfile', chatId, profileId]),
      },
      agent,
      chatItem,
      profileCatalog,
      note: text => log.notes.push(text),
      fail: text => log.fails.push(text),
    },
  };
}

export const callsTo = (log, name) => log.calls.filter(([called]) => called === name);
export const spoke = log => [...log.notes, ...log.fails];
