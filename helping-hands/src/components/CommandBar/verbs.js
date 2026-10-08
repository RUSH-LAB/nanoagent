/** The only slash commands in an agent chat: select its harness and model. */

const HARNESS_LABELS = Object.freeze({
  native: 'NanoAgent',
  hermes: 'Hermes Agent',
  pi: 'PI',
});

function harnessLabel(harness) {
  return HARNESS_LABELS[harness] ?? harness;
}

function profilesFor(ctx) {
  return Array.isArray(ctx.profileCatalog?.profiles) ? ctx.profileCatalog.profiles : [];
}

function currentProfile(ctx) {
  const profileId = ctx.chatItem?.profileId
    || ctx.agent?.profileId
    || ctx.profileCatalog?.defaultProfile;
  return profilesFor(ctx).find(profile => profile.id === profileId) ?? null;
}

function inAgentChat(ctx, verb) {
  if (ctx.session?.target?.chatId && ctx.session?.target?.agentId && ctx.chatItem) return true;
  ctx.fail(`/${verb} needs an open agent chat`);
  return false;
}

function unavailableMessage(profile) {
  return `unavailable${profile?.unavailableReason ? `: ${profile.unavailableReason}` : ''}`;
}

function modelChoices(profiles) {
  return profiles.map(profile => (
    `${profile.model}${profile.available === false ? ' (unavailable)' : ''}`
  )).join(', ') || 'none';
}

const inOpenAgentChat = ctx => Boolean(
  ctx.session?.target?.chatId && ctx.session?.target?.agentId,
);

export const VERBS = [
  {
    id: 'verb-harness',
    name: 'harness',
    category: 'Agent',
    icon: 'star',
    title: 'Agent harness',
    description: 'Show or switch this chat’s harness',
    usage: '[nanoagent|hermes|pi]',
    when: inOpenAgentChat,
    options(ctx) {
      const profiles = profilesFor(ctx);
      const current = currentProfile(ctx);
      return [...new Set(profiles.map(profile => profile.harness))].map(harness => {
        const candidates = profiles.filter(profile => profile.harness === harness);
        const available = candidates.some(profile => profile.available !== false);
        return {
          id: `harness-${harness}`,
          value: harness === 'native' ? 'nanoagent' : harness,
          name: harnessLabel(harness),
          description: [...new Set(candidates.map(profile => profile.model))].join(', '),
          category: current?.harness === harness ? 'Current' : (available ? 'Harness' : 'Unavailable'),
          current: current?.harness === harness,
          available,
        };
      }).sort((a, b) => Number(b.current) - Number(a.current));
    },
    run(ctx, argLine) {
      if (!inAgentChat(ctx, 'harness')) return;
      const profiles = profilesFor(ctx);
      const current = currentProfile(ctx);
      const harnesses = [...new Set(profiles.map(profile => profile.harness))];
      const wanted = String(argLine ?? '').trim().toLowerCase();

      if (!wanted) {
        ctx.note([
          `harness: ${current ? harnessLabel(current.harness) : 'unknown'}`,
          `choices: ${harnesses.map(harnessLabel).join(', ') || 'none'}`,
        ].join('\n'));
        return;
      }

      const harness = wanted === 'nanoagent'
        ? 'native'
        : (wanted === 'hermes agent' ? 'hermes' : wanted);
      if (!harnesses.includes(harness)) {
        ctx.fail(`/harness: choose one of ${harnesses.map(harnessLabel).join(', ') || 'the configured harnesses'}`);
        return;
      }

      const choices = profiles.filter(profile => profile.harness === harness);
      const next = choices.find(profile => (
        profile.model === current?.model && profile.available !== false
      )) || choices.find(profile => profile.available !== false);
      if (!next) {
        ctx.fail(`/harness ${wanted}: ${unavailableMessage(choices[0])}`);
        return;
      }

      ctx.sessions.setChatProfile(ctx.chatItem.id, next.id);
      ctx.note(`harness: ${harnessLabel(next.harness)} · model: ${next.model}`);
    },
  },
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
      const current = currentProfile(ctx);
      if (!current) return [];
      return profilesFor(ctx)
        .filter(profile => profile.harness === current.harness)
        .map(profile => ({
          id: `model-${profile.id}`,
          // Prefer the human model name in the terminal. Fall back to the
          // profile id only when two profiles in this harness share it.
          value: profilesFor(ctx).filter(candidate => (
            candidate.harness === current.harness && candidate.model === profile.model
          )).length === 1 ? profile.model : profile.id,
          name: profile.model,
          description: profile.label,
          category: profile.id === current.id
            ? 'Current'
            : (profile.available === false ? 'Unavailable' : 'Model'),
          current: profile.id === current.id,
          available: profile.available !== false,
        }))
        .sort((a, b) => Number(b.current) - Number(a.current));
    },
    run(ctx, argLine) {
      if (!inAgentChat(ctx, 'model')) return;
      const current = currentProfile(ctx);
      if (!current) {
        ctx.fail('/model: this chat’s profile is no longer configured');
        return;
      }

      const choices = profilesFor(ctx).filter(profile => profile.harness === current.harness);
      const wanted = String(argLine ?? '').trim().toLowerCase();
      if (!wanted) {
        ctx.note([
          `model: ${current.model}`,
          `harness: ${harnessLabel(current.harness)}`,
          `choices: ${modelChoices(choices)}`,
        ].join('\n'));
        return;
      }

      const matches = choices.filter(profile => (
        profile.id.toLowerCase() === wanted
        || profile.model.toLowerCase() === wanted
        || profile.label.toLowerCase() === wanted
      ));
      if (matches.length !== 1) {
        const reason = matches.length ? 'more than one profile matches' : 'choose one of';
        ctx.fail(`/model: ${reason} ${modelChoices(choices)}`);
        return;
      }

      const [next] = matches;
      if (next.available === false) {
        ctx.fail(`/model ${String(argLine).trim()}: ${unavailableMessage(next)}`);
        return;
      }

      ctx.sessions.setChatProfile(ctx.chatItem.id, next.id);
      ctx.note(`model: ${next.model} · harness: ${harnessLabel(next.harness)}`);
    },
  },
];
