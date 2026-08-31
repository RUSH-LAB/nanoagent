/**
 * The commands that do something rather than going somewhere.
 *
 * Every entry in src/components/commands.js is a place: running it navigates.
 * That was the whole registry once the tools became plugins, and it is why the
 * CLI could split a window with a key and a button but not with a command. A
 * verb has a `run` instead of an `href`, and the CLI concatenates this list onto
 * the navigation one so both kinds share a single slash menu.
 *
 * Icons are named rather than held, exactly as a plugin names one. This module
 * has to stay loadable by `node --test`, which rules out importing the icon
 * elements from src/components/commands.js, and the completion list resolves
 * the name when it draws the row.
 *
 * Four rules hold for every verb below, and they are why the helpers exist:
 *
 * 1. A verb answers. It reports through `note` when it worked and through
 *    `fail` when it did not, so a pane is never left silent wondering whether
 *    anything happened.
 * 2. A refusal says what was refused and why, naming the verb, because the line
 *    that caused it has already scrolled into the transcript as plain text.
 * 3. It echoes the server, not the typing. A channel name is normalised on the
 *    way in (trimmed, lowercased, spaces to dashes), so `/rename My Room`
 *    reports `my-room`; reporting `My Room` would be a lie the reader only
 *    discovers later.
 * 4. An argument that names nothing, or names two things, is a refusal that
 *    says so. Guessing between two people is how a message reaches the wrong
 *    one, and there is no undo for that.
 *
 * `when(ctx)` hides a verb that cannot apply here: channel verbs in an
 * assistant pane, `/unarchive` on a channel that is not archived, the
 * administrative ones from someone who does not administer this channel. It is
 * courtesy rather than security, and the server decides again. It reads only
 * `ctx.session` and `ctx.chat`, deliberately: the full context carries the
 * command list, and the command list is what the filter is producing, so a
 * `when` that needed the whole of it could never be called.
 */
import {resolveCommand} from './commandRuntime.js';
import {copyLink} from '../../utils/invite.js';

/* The name column in the help table. Wide enough for the longest verb plus its
   usage without wrapping in a pane half the window wide. */
const HELP_NAME_WIDTH = 18;

/* How long a destructive verb remembers having been asked. Long enough to type
   the same line again on purpose, short enough that the same line an hour later
   is a fresh question rather than a confirmation of a forgotten one. */
const CONFIRM_MS = 5000;

/* How much of a message is quoted back when confirming or reporting a delete:
   enough to recognise which line it was, not enough to redraw it. */
const PREVIEW_CHARS = 60;

/* How many names /who prints before it stops and counts the rest. A pane is a
   few lines tall and a large organization would bury the prompt. */
const WHO_LIMIT = 40;

/* ── Reading the pane ─────────────────────────────────────────────── */

/**
 * How a person is written before a dm with them exists.
 *
 * A second spelling of ChatSidebar's `personLabel`, because that module is JSX
 * and importing it here would put a JSX transform in the import graph of a file
 * `node --test` has to load.
 */
const personLabel = (person) => `@${person.username || person.name || person.email || 'someone'}`;

/** How a channel is written: #name, or @peer when it is a direct message. */
function channelLabel(channel) {
  if (!channel) return 'this channel';
  if (channel.kind === 'dm') return `@${channel.peerUsername || channel.peerName || 'someone'}`;
  return channel.name ? `#${channel.name}` : (channel.label || 'this channel');
}

/**
 * The channel this pane is pointed at, or null when it is on the assistant.
 *
 * Read from the directory rather than from the target, so a channel renamed by
 * somebody else is reported by the name it has now. A channel the directory no
 * longer lists (archiving takes it out of the list) still answers with its id,
 * because the verbs that bring it back need one.
 */
function paneChannel(ctx) {
  const target = ctx.session?.target;
  if (!target?.channelId) return null;
  const row = (ctx.chat?.channels ?? []).find((c) => c.id === target.channelId);
  return row ?? {id: target.channelId, name: null, kind: null, label: target.label};
}

/**
 * Whether the pane's channel looks archived.
 *
 * An archived channel is filtered out of the directory, so its absence is the
 * signal. That reading is only safe once the directory has arrived: before it
 * does, every channel is missing and every pane would look archived.
 */
function paneArchived(ctx) {
  if (ctx.chat?.status !== 'ready') return false;
  const channel = paneChannel(ctx);
  if (!channel) return false;
  return Boolean(channel.archivedAt) || !ctx.chat.channels.some((c) => c.id === channel.id);
}

/**
 * Whether the caller may administer the pane's channel, as far as the client
 * can tell: the server's rule is the channel's creator or an organization
 * manager, and both halves are on the rows we already hold.
 */
function mayAdminister(ctx) {
  const you = ctx.chat?.you;
  if (!you) return false;
  return Boolean(you.canManage) || paneChannel(ctx)?.createdBy === you.userId;
}

/** A channel verb applies when the pane is on a channel that is not a dm. */
function onChannel(ctx) {
  const channel = paneChannel(ctx);
  return Boolean(channel) && channel.kind !== 'dm';
}

/** The administrative verbs: a live channel this caller may change. */
const onAdministrableChannel = (ctx) => onChannel(ctx) && mayAdminister(ctx) && !paneArchived(ctx);

/* ── Refusing ─────────────────────────────────────────────────────── */

/** The pane's channel, or null having said why there is not one. */
function needChannel(ctx, verb) {
  const channel = paneChannel(ctx);
  if (channel) return channel;
  ctx.fail(`/${verb} needs a conversation: this pane is on the assistant`);
  return null;
}

/** The argument line, or null having said what it should have contained. */
function needText(ctx, verb, argLine, usage) {
  const text = String(argLine ?? '').trim();
  if (text) return text;
  ctx.fail(`/${verb} needs an argument: /${verb} ${usage}`);
  return null;
}

/**
 * The one person an argument names, or null having said that it names none or
 * more than one. `findPerson` returns null for both, which is the point: a
 * verb that guessed between two people would send somebody else's mail.
 */
function needPerson(ctx, verb, argLine) {
  const wanted = needText(ctx, verb, argLine, '@person');
  if (!wanted) return null;
  const person = ctx.chat.findPerson(wanted);
  if (person) return person;
  ctx.fail(`/${verb}: no single person here matches ${wanted}`);
  return null;
}

/** The one channel an argument names, on the same terms. */
function needChannelNamed(ctx, verb, argLine) {
  const wanted = needText(ctx, verb, argLine, '#channel');
  if (!wanted) return null;
  const channel = ctx.chat.findChannel(wanted);
  if (channel) return channel;
  ctx.fail(`/${verb}: no single channel here matches ${wanted}`);
  return null;
}

/* ── Reading what the server sent back ────────────────────────────── */

/**
 * The channel row inside whatever a write resolved to.
 *
 * The writes are thin wrappers over endpoints that answer `{channel}`, and a
 * couple of them shorten that to the id. Both are accepted here so that a verb
 * reports the server's name when there is one and stays quiet about the name
 * when there is not, rather than falling back to the typed one.
 */
function rowOf(result) {
  if (!result || typeof result === 'string') return null;
  const row = result.channel ?? result;
  return row && typeof row === 'object' && row.name !== undefined ? row : null;
}

/** The channel id inside whatever a write resolved to. */
function idOf(result) {
  if (typeof result === 'string') return result;
  return result?.channel?.id ?? result?.id ?? null;
}

/** A channel name for a message, preferring the server's spelling. */
function namedBy(result, fallback) {
  const row = rowOf(result);
  return row ? channelLabel(row) : fallback;
}

/** One line of a message, short enough to sit inside a sentence. */
function preview(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/* ── Confirming ───────────────────────────────────────────────────── */

/**
 * What has been asked once and not yet done, keyed by pane and by what the
 * verb is about to touch, so confirming a kick cannot confirm a delete.
 *
 * Module state rather than pane state on purpose: a confirmation is a property
 * of the last few seconds, not of the transcript, and nothing about it should
 * survive a reload or be worth persisting.
 */
const pending = new Map();

/**
 * True when this exact request was already made moments ago, which is the
 * second half of "type it twice". Anything older than the window is treated as
 * a fresh first ask, so a repeat tomorrow still gets its question.
 */
function confirmedTwice(ctx, key) {
  const now = Date.now();
  for (const [k, at] of pending) if (now - at > CONFIRM_MS) pending.delete(k);
  const mapKey = `${ctx.session?.id}:${key}`;
  if (pending.has(mapKey)) {
    pending.delete(mapKey);
    return true;
  }
  pending.set(mapKey, now);
  return false;
}

/* ── Help ─────────────────────────────────────────────────────────── */

/** How one command reads in the table: its call, then what it is for. */
function helpLine(cmd) {
  const call = `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ''}`;
  return `${call.padEnd(HELP_NAME_WIDTH)} ${cmd.description ?? ''}`.trimEnd();
}

/* ── The verbs ────────────────────────────────────────────────────── */

export const VERBS = [
  {
    id: 'verb-help',
    name: 'help',
    category: 'CLI',
    icon: 'info',
    title: 'Help',
    description: 'Every command, or one in detail',
    usage: '[verb]',
    run(ctx, argLine) {
      // A leading slash is what anyone types when asking about a command, so
      // `/help /split` means the same as `/help split`.
      const wanted = argLine.trim().replace(/^\//, '');
      if (wanted) {
        const cmd = resolveCommand(ctx.commands, wanted);
        if (!cmd) {
          ctx.fail(`no command called /${wanted}`);
          return;
        }
        const detail = [
          helpLine(cmd),
          cmd.href ? `goes to ${cmd.href}` : null,
        ].filter(Boolean).join('\n');
        ctx.note(detail);
        return;
      }
      ctx.note(ctx.commands.map(helpLine).join('\n'));
    },
  },
  {
    id: 'verb-clear',
    name: 'clear',
    category: 'CLI',
    icon: 'eraser',
    title: 'Clear',
    description: 'Empty this pane',
    run(ctx) {
      ctx.sessions.clear(ctx.session.id);
    },
  },
  {
    id: 'verb-split',
    name: 'split',
    category: 'CLI',
    icon: 'split',
    title: 'Split',
    description: 'Open another pane beside this one',
    run(ctx) {
      if (ctx.sessions.split() === null) {
        ctx.fail(`${ctx.sessions.MAX_SESSIONS} panes is the limit`);
      }
    },
  },
  {
    id: 'verb-close',
    name: 'close',
    category: 'CLI',
    icon: 'split',
    title: 'Close',
    description: 'Close this pane',
    run(ctx) {
      // Nothing is said on success: the pane that would have been told about it
      // is the one that just went away.
      if (!ctx.sessions.close(ctx.session.id)) {
        ctx.fail('this is the only pane');
        return;
      }
      // A pane that goes away takes its request with it. Nothing is left to
      // draw the answer, and the server only stops generating one when the
      // client hangs up, so the cancel is what makes the close mean anything.
      // It comes after the close on purpose: the last pane refuses to close and
      // must keep working.
      ctx.assistant?.cancel(ctx.session.id);
    },
  },

  /* Conversations: pointing this pane at one, and making one to point at. */

  {
    id: 'verb-dm',
    name: 'dm',
    category: 'Chat',
    icon: 'note',
    title: 'Direct message',
    description: 'Open a direct message and point this pane at it',
    usage: '@person',
    async run(ctx, argLine) {
      const person = needPerson(ctx, 'dm', argLine);
      if (!person) return;
      const channelId = idOf(await ctx.chat.openDm(person.id));
      if (!channelId) {
        ctx.fail(`/dm: the server opened no conversation with ${personLabel(person)}`);
        return;
      }
      const label = personLabel(person);
      ctx.sessions.setTarget(ctx.session.id, {channelId, label});
      ctx.note(`this pane is now ${label}`);
    },
  },
  {
    id: 'verb-join',
    name: 'join',
    category: 'Chat',
    icon: 'plus',
    title: 'Join',
    description: 'Join a public channel and open it',
    usage: '#channel',
    async run(ctx, argLine) {
      const channel = needChannelNamed(ctx, 'join', argLine);
      if (!channel) return;
      const result = await ctx.chat.join(channel.id);
      const label = namedBy(result, channelLabel(channel));
      ctx.sessions.setTarget(ctx.session.id, {channelId: channel.id, label});
      ctx.note(result?.joined === false
        ? `you were already in ${label}, so this pane is on it`
        : `joined ${label}`);
    },
  },
  {
    id: 'verb-new',
    name: 'new',
    category: 'Chat',
    icon: 'plus',
    title: 'New channel',
    description: 'Create a channel and open it',
    usage: '#name',
    async run(ctx, argLine) {
      const wanted = needText(ctx, 'new', argLine, '#name');
      if (!wanted) return;
      // The server normalises spacing and case but not the sigil, so a `#`
      // left on would become part of the name.
      const result = await ctx.chat.createChannel(wanted.replace(/^#/, ''));
      const channelId = idOf(result);
      if (!channelId) {
        ctx.fail('/new: the server created no channel');
        return;
      }
      const row = rowOf(result);
      // Without a row there is no server spelling to echo, so the pane is
      // labelled from the target and corrected by the directory a moment later.
      const label = row ? channelLabel(row) : `#${wanted.replace(/^#/, '')}`;
      ctx.sessions.setTarget(ctx.session.id, {channelId, label});
      ctx.note(row ? `created ${label}` : 'created the channel and opened it');
    },
  },
  {
    id: 'verb-leave',
    name: 'leave',
    category: 'Chat',
    icon: 'navigate',
    title: 'Leave',
    description: 'Leave the channel this pane is on',
    when: onChannel,
    async run(ctx) {
      const channel = needChannel(ctx, 'leave');
      if (!channel) return;
      const label = channelLabel(channel);
      const result = await ctx.chat.leave(channel.id);
      if (result?.left === false) {
        ctx.note(`you were not in ${label}`);
        return;
      }
      // Pointing the pane back at the assistant is the honest end of leaving: a
      // private channel is gone from the directory, and a public one is now
      // something being read rather than taken part in.
      ctx.sessions.setTarget(ctx.session.id, null);
      ctx.note(`left ${label}; this pane is back on the assistant`);
    },
  },

  /* Membership, naming and archiving: the administrative half. */

  {
    id: 'verb-invite',
    name: 'invite',
    category: 'Chat',
    icon: 'navigate',
    title: 'Invite',
    description: 'Invite an address into the organization',
    usage: 'email',
    when: (ctx) => Boolean(ctx.chat?.you?.canManage),
    async run(ctx, argLine) {
      const email = needText(ctx, 'invite', argLine, 'name@example.com');
      if (!email) return;
      const invitation = await ctx.chat.invite(email);
      const invited = invitation?.email ?? email;
      if (!invitation?.id) {
        ctx.note(`invited ${invited}`);
        return;
      }
      // The pane is too narrow for a link, so it goes to the clipboard; a
      // browser may refuse that, and then the link itself is the answer.
      const {copied, link} = await copyLink(invitation.id);
      ctx.note(copied
        ? `invited ${invited}; the link is on your clipboard`
        : `invited ${invited}; the link is ${link}`);
    },
  },
  {
    id: 'verb-add',
    name: 'add',
    category: 'Chat',
    icon: 'plus',
    title: 'Add someone',
    description: 'Add someone to this channel',
    usage: '@person',
    when: onAdministrableChannel,
    async run(ctx, argLine) {
      const channel = needChannel(ctx, 'add');
      if (!channel) return;
      const person = needPerson(ctx, 'add', argLine);
      if (!person) return;
      const result = await ctx.chat.addMember(channel.id, person.id);
      const label = channelLabel(channel);
      ctx.note(result?.added === false
        ? `${personLabel(person)} was already in ${label}`
        : `added ${personLabel(person)} to ${label}`);
    },
  },
  {
    id: 'verb-kick',
    name: 'kick',
    category: 'Chat',
    icon: 'eraser',
    title: 'Remove someone',
    description: 'Remove someone from this channel',
    usage: '@person',
    when: onAdministrableChannel,
    async run(ctx, argLine) {
      const channel = needChannel(ctx, 'kick');
      if (!channel) return;
      const person = needPerson(ctx, 'kick', argLine);
      if (!person) return;
      const label = channelLabel(channel);
      if (!confirmedTwice(ctx, `kick:${channel.id}:${person.id}`)) {
        ctx.note(`/kick ${personLabel(person)} again within five seconds to remove them from ${label}`);
        return;
      }
      const result = await ctx.chat.removeMember(channel.id, person.id);
      ctx.note(result?.removed === false
        ? `${personLabel(person)} was not in ${label}`
        : `removed ${personLabel(person)} from ${label}`);
    },
  },
  {
    id: 'verb-rename',
    name: 'rename',
    category: 'Chat',
    icon: 'note',
    title: 'Rename',
    description: 'Rename this channel',
    usage: '#name',
    when: onAdministrableChannel,
    async run(ctx, argLine) {
      const channel = needChannel(ctx, 'rename');
      if (!channel) return;
      const wanted = needText(ctx, 'rename', argLine, '#name');
      if (!wanted) return;
      const was = channelLabel(channel);
      const result = await ctx.chat.update(channel.id, {name: wanted.replace(/^#/, '')});
      const row = rowOf(result);
      if (row) ctx.sessions.setTarget(ctx.session.id, {channelId: channel.id, label: channelLabel(row)});
      ctx.note(row ? `${was} is now ${channelLabel(row)}` : `renamed ${was}`);
    },
  },
  {
    id: 'verb-topic',
    name: 'topic',
    category: 'Chat',
    icon: 'note',
    title: 'Topic',
    description: "Set this channel's topic, or clear it",
    usage: 'text',
    when: onAdministrableChannel,
    async run(ctx, argLine) {
      const channel = needChannel(ctx, 'topic');
      if (!channel) return;
      // An empty line is meaningful here rather than missing: it is how a topic
      // is taken down, which is why this verb does not go through needText.
      const wanted = String(argLine ?? '').trim();
      const label = channelLabel(channel);
      const result = await ctx.chat.update(channel.id, {topic: wanted});
      const row = rowOf(result);
      // With no row to read back, what was asked for is all there is to report,
      // and reporting a cleared topic because none came back would be wrong.
      if (!row) {
        ctx.note(wanted ? `set the topic of ${label}` : `cleared the topic of ${label}`);
        return;
      }
      ctx.note(row.topic ? `topic of ${label}: ${row.topic}` : `cleared the topic of ${label}`);
    },
  },
  {
    id: 'verb-archive',
    name: 'archive',
    category: 'Chat',
    icon: 'layers',
    title: 'Archive',
    description: 'Put this channel out of the way, read-only',
    when: onAdministrableChannel,
    async run(ctx) {
      const channel = needChannel(ctx, 'archive');
      if (!channel) return;
      const label = channelLabel(channel);
      const result = await ctx.chat.archive(channel.id, true);
      // The pane stays pointed at it on purpose: an archived channel leaves the
      // rail, and this pane is then the only place /unarchive can be typed.
      ctx.note(result?.changed === false
        ? `${label} was already archived`
        : `archived ${label}; it is read-only until /unarchive`);
    },
  },
  {
    id: 'verb-unarchive',
    name: 'unarchive',
    category: 'Chat',
    icon: 'layers',
    title: 'Unarchive',
    description: 'Bring this channel back',
    when: (ctx) => onChannel(ctx) && mayAdminister(ctx) && paneArchived(ctx),
    async run(ctx) {
      const channel = needChannel(ctx, 'unarchive');
      if (!channel) return;
      const result = await ctx.chat.archive(channel.id, false);
      const label = namedBy(result, channelLabel(channel));
      ctx.note(result?.changed === false ? `${label} was not archived` : `brought ${label} back`);
    },
  },

  /* Looking around, asking, and taking something back. */

  {
    id: 'verb-who',
    name: 'who',
    category: 'Chat',
    icon: 'list',
    title: 'Who',
    description: 'Who is in this channel, or in the organization',
    run(ctx) {
      const channel = paneChannel(ctx);
      if (!channel) {
        const people = ctx.chat.people ?? [];
        const you = ctx.chat.you;
        if (people.length === 0) {
          ctx.note(you ? 'you are the only person in this organization' : 'nobody to list yet');
          return;
        }
        const shown = people.slice(0, WHO_LIMIT).map(personLabel);
        const rest = people.length - shown.length;
        ctx.note([
          `${people.length + (you ? 1 : 0)} in this organization`,
          shown.join(' '),
          rest > 0 ? `and ${rest} more` : null,
        ].filter(Boolean).join('\n'));
        return;
      }

      const label = channelLabel(channel);
      if (channel.kind === 'dm') {
        ctx.note(`${label} is a direct message: the two of you`);
        return;
      }
      // The directory carries the count, not the roster. When the chat hook can
      // list a channel's members it is used; until then the count is what is
      // true, and inventing names from the organization would not be.
      if (typeof ctx.chat.members === 'function') {
        const members = ctx.chat.members(channel.id) ?? [];
        if (members.length) {
          const shown = members.slice(0, WHO_LIMIT).map(personLabel);
          const rest = members.length - shown.length;
          ctx.note([`${label}`, shown.join(' '), rest > 0 ? `and ${rest} more` : null]
            .filter(Boolean).join('\n'));
          return;
        }
      }
      const count = channel.memberCount ?? 0;
      ctx.note(`${label} · ${count} ${count === 1 ? 'member' : 'members'}`);
    },
  },
  {
    id: 'verb-ai',
    name: 'ai',
    category: 'Assistant',
    icon: 'star',
    title: 'Ask the assistant',
    description: 'Ask a question without posting it',
    usage: 'question',
    when: (ctx) => Boolean(ctx.session?.target),
    async run(ctx, argLine) {
      const question = needText(ctx, 'ai', argLine, 'what did we decide?');
      if (!question) return;
      const channel = paneChannel(ctx);
      // Said before the answer arrives, because the question is about to appear
      // in a pane full of messages and must not read as one.
      ctx.note(`asking the assistant; nothing is posted to ${channelLabel(channel)}`);
      await ctx.assistant.ask(ctx.session.id, question);
    },
  },
  {
    id: 'verb-delete',
    name: 'delete',
    category: 'Chat',
    icon: 'eraser',
    title: 'Delete',
    description: 'Delete your most recent message here',
    when: (ctx) => Boolean(paneChannel(ctx)),
    async run(ctx) {
      const channel = needChannel(ctx, 'delete');
      if (!channel) return;
      const youId = ctx.chat.you?.userId;
      if (!youId) {
        ctx.fail('/delete: nobody is signed in, so there is nothing of yours to delete');
        return;
      }
      const label = channelLabel(channel);
      const messages = ctx.chat.conversation(channel.id)?.messages ?? [];
      // Newest first, and a message already deleted is not one to delete again.
      const mine = [...messages].reverse().find((m) => m.userId === youId && !m.deletedAt);
      if (!mine) {
        ctx.fail(`/delete: you have said nothing in ${label} that is still there`);
        return;
      }
      const quoted = preview(mine.body);
      if (!confirmedTwice(ctx, `delete:${mine.id}`)) {
        ctx.note(`/delete again within five seconds to delete "${quoted}"`);
        return;
      }
      await ctx.chat.deleteMessage(mine.id);
      ctx.note(`deleted "${quoted}"`);
    },
  },
];
