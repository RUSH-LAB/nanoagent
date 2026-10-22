/**
 * The only slash command in an agent chat: show or switch the chat's model.
 *
 * A chat runs on the model it chose here, else the member's model in
 * Settings → Usage (one their own server serves), else NanoAgent's default, all
 * on the member's computer (`ctx.ai`: its models from /api/ai/models, and the settings).
 */

function chatModels(ctx) {
  return (ctx.ai?.models ?? []).filter(model => model.uses.includes('chat'));
}

/** The key of the model this chat runs on. */
function currentKey(ctx) {
  const {settings, defaults} = ctx.ai ?? {};
  const own = ctx.chatItem?.modelChoice;
  if (own) return own.key;
  const mine = settings?.model;
  if (mine) return `${mine.provider}/${mine.model}`;
  return defaults?.chat ?? null;
}

function inAgentChat(ctx) {
  if (ctx.session?.target?.chatId && ctx.session?.target?.agentId && ctx.chatItem) return true;
  ctx.fail('/model needs an open agent chat');
  return false;
}

const describe = model => `${model.label} (${model.providerName ?? model.provider ?? 'NanoAgent'})`;

const inOpenAgentChat = ctx => Boolean(
  ctx.session?.target?.chatId && ctx.session?.target?.agentId,
);

export const VERBS = [
  {
    id: 'verb-model',
    name: 'model',
    category: 'Agent',
    icon: 'star',
    title: 'Agent model',
    description: 'Show or switch this chat’s model',
    usage: '[model]',
    when: inOpenAgentChat,
    options(ctx) {
      const current = currentKey(ctx);
      return chatModels(ctx)
        .filter(model => model.available || model.key === current)
        .map(model => ({
          id: `model-${model.key}`,
          value: model.key,
          name: model.label,
          description: model.providerName ?? model.provider ?? '',
          category: model.key === current ? 'Current' : 'Model',
          current: model.key === current,
          available: model.available,
        }))
        .sort((a, b) => Number(b.current) - Number(a.current));
    },
    run(ctx, argLine) {
      if (!inAgentChat(ctx)) return;
      const models = chatModels(ctx);
      const current = models.find(model => model.key === currentKey(ctx));
      const wanted = String(argLine ?? '').trim().toLowerCase();
      if (!wanted) {
        ctx.note([
          `model: ${current ? describe(current) : 'NanoAgent’s default'}`,
          'switch with /model <name>; choose your default in Settings → Usage',
        ].join('\n'));
        return;
      }
      const matches = models.filter(model => (
        model.key.toLowerCase() === wanted
        || model.model.toLowerCase() === wanted
        || model.label.toLowerCase() === wanted
      ));
      if (matches.length !== 1) {
        ctx.fail(`/model: ${matches.length ? 'more than one model matches' : 'no model matches'} ${String(argLine).trim()}`);
        return;
      }
      const [next] = matches;
      if (!next.available) {
        ctx.fail(`/model ${String(argLine).trim()}: unavailable${next.unavailableReason ? `: ${next.unavailableReason}` : ''}`);
        return;
      }
      ctx.sessions.setChatModel(ctx.chatItem.id, {key: next.key, choice: next.choice});
      ctx.note(`model: ${describe(next)}`);
    },
  },
];
