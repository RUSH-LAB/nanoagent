export const AI = Object.freeze({
  defaults: {chat: 'openrouter/org/fast'},
  settings: {behaviour: {}, instructions: '', model: null},
  models: [
    {key: 'openrouter/org/fast', choice: {provider: 'openrouter', model: 'org/fast'}, label: 'Fast', provider: 'openrouter', model: 'org/fast', uses: ['chat', 'inline'], available: true},
    {key: 'openrouter/org/smart', choice: {provider: 'openrouter', model: 'org/smart'}, label: 'Smart', provider: 'openrouter', model: 'org/smart', uses: ['chat', 'inline'], available: true},
    {key: 'openrouter/org/apps', choice: {provider: 'openrouter', model: 'org/apps'}, label: 'Apps', provider: 'openrouter', model: 'org/apps', uses: ['apps'], available: true},
    {key: 'openrouter/org/off', choice: {provider: 'openrouter', model: 'org/off'}, label: 'Off', provider: 'openrouter', model: 'org/off', uses: ['chat'], available: false, unavailableReason: 'Needs your OpenRouter key: add it under API keys'},
  ],
});

export function makeCtx(options = {}) {
  const target = options.target === undefined
    ? {chatId: 'chat-1', agentId: 'mochi', label: 'Chat'}
    : options.target;
  const chatItem = options.chatItem === undefined
    ? (target?.chatId ? {id: target.chatId, agentId: target.agentId} : null)
    : options.chatItem;
  const log = {notes: [], fails: [], calls: []};
  return {
    log,
    ctx: {
      session: {id: options.sessionId ?? 's1', target},
      sessions: {
        setChatModel: (chatId, choice) => log.calls.push(['setChatModel', chatId, choice]),
      },
      agent: {id: 'mochi', name: 'Mochi'},
      chatItem,
      ai: options.ai ?? AI,
      note: text => log.notes.push(text),
      fail: text => log.fails.push(text),
    },
  };
}

export const callsTo = (log, name) => log.calls.filter(([called]) => called === name);
export const spoke = log => [...log.notes, ...log.fails];
