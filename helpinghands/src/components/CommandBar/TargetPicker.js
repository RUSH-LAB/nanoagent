import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import {ConversationIcon} from './ChatSidebar';
import styles from './targetPicker.module.css';

/**
 * Who the minimised line talks to, and the way to change it without opening
 * the window. It sits where the window's rail sits, so the field beside it is
 * the same width minimised and open.
 *
 * Two buttons, each with a list that opens upwards, because the bar is at the
 * bottom of the screen: the first chooses the kind (an agent, a channel, or a
 * person) and shows it as an icon, the second which one, by name. Choosing a kind opens the second list on it,
 * and the line's target changes only when one is picked. With the rail hidden
 * it is `compact`, a pair of chips in the prompt row instead.
 */

const CATEGORIES = Object.freeze([
  {id: 'agent', label: 'Agent', find: 'Find an agent', none: 'No agents yet.'},
  {id: 'channel', label: 'Channel', find: 'Find a channel', none: 'No channels yet.'},
  {id: 'person', label: 'Person', find: 'Find a person', none: 'No people yet.'},
]);

const personLabel = person => person.username || person.name || person.email || 'Someone';

function Caret() {
  return (
    <svg className={styles.caret} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 15 12 9 18 15" />
    </svg>
  );
}

function CategoryIcon({id}) {
  const common = {width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true};
  if (id === 'agent') return <svg {...common}><rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 3v4M9 13h.01M15 13h.01" /></svg>;
  if (id === 'channel') return <svg {...common}><path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" /></svg>;
  return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
}

/**
 * The list a DropUp opens, mounted only while open so that every opening starts
 * unfiltered, on the row already chosen.
 */
function Menu({id, label, rows, selectedKey, onPick, onClose, filter, empty}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex(row => row.key === selectedKey)));
  const field = useRef(null);
  const list = useRef(null);
  useEffect(() => { (filter ? field.current : list.current)?.focus(); }, [filter]);

  const wanted = query.trim().toLowerCase();
  const shown = filter && wanted ? rows.filter(row => row.label.toLowerCase().includes(wanted)) : rows;

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (event.key === 'Enter' && shown[active]) {
      event.preventDefault();
      onPick(shown[active]);
    }
  };

  const listId = `${id}-list`;
  const activeId = shown[active] ? `${id}-${active}` : undefined;
  return (
    <div className={styles.menu}>
      {filter && (
        <input
          ref={field}
          className={styles.filter}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder={filter}
          aria-label={filter}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
        />
      )}
      <div
        ref={list}
        className={styles.list}
        id={listId}
        role="listbox"
        aria-label={label}
        tabIndex={filter ? undefined : -1}
        onKeyDown={filter ? undefined : onKeyDown}
        aria-activedescendant={filter ? undefined : activeId}
      >
        {shown.map((row, index) => (
          <div
            key={row.key}
            id={`${id}-${index}`}
            role="option"
            aria-selected={row.key === selectedKey}
            className={`${styles.row} ${index === active ? styles.rowActive : ''} ${row.key === selectedKey ? styles.rowCurrent : ''}`}
            // Down rather than click, so focus stays in the list until the pick closes it.
            onMouseDown={(event) => { event.preventDefault(); onPick(row); }}
            onMouseEnter={() => setActive(index)}
          >
            {row.icon}
            <span className={styles.rowLabel}>{row.label}</span>
            {row.unread > 0 && <span className={styles.unread}>{row.unread > 99 ? '99+' : row.unread}</span>}
          </div>
        ))}
        {shown.length === 0 && <p className={styles.empty}>{wanted ? `Nothing matches “${query.trim()}”.` : empty}</p>}
      </div>
    </div>
  );
}

/**
 * A button and the list it opens above itself. Arrows move, Enter picks, Escape
 * closes, and a `filter` adds a field at the top that narrows the rows.
 */
function DropUp({id, open, onOpenChange, trigger, triggerLabel, rows, selectedKey, onPick, filter = null, empty, className = ''}) {
  const wrapper = useRef(null);
  useClickOutside(wrapper, () => onOpenChange(false), open);
  return (
    <div className={`${styles.dropUp} ${className}`} ref={wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => onOpenChange(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        {trigger}
        <Caret />
      </button>
      {open && (
        <Menu
          id={id}
          label={triggerLabel}
          rows={rows}
          selectedKey={selectedKey}
          onPick={(row) => { onOpenChange(false); onPick(row); }}
          onClose={() => onOpenChange(false)}
          filter={filter}
          empty={empty}
        />
      )}
    </div>
  );
}

export default function TargetPicker({compact = false, current, agents, channels, people, onPickAgent, onPickChannel, onPickPerson}) {
  const currentCategory = current.agent ? 'agent' : current.person ? 'person' : current.channel ? 'channel' : null;
  // The kind shown, which runs ahead of the target while one is being chosen.
  const [category, setCategory] = useState(currentCategory ?? 'agent');
  const [openList, setOpenList] = useState(null);
  useEffect(() => { if (currentCategory) setCategory(currentCategory); }, [currentCategory]);

  // Unread messages by kind: channels' own, and people's direct messages.
  const unreadIn = useMemo(() => {
    const totals = {agent: 0, channel: 0, person: 0};
    for (const channel of channels) totals[channel.kind === 'dm' ? 'person' : 'channel'] += channel.unread ?? 0;
    return totals;
  }, [channels]);

  const choices = useMemo(() => {
    if (category === 'agent') {
      return agents.map(agent => ({
        key: `agent:${agent.id}`, label: agent.name, icon: <ConversationIcon agent={agent} />, pick: () => onPickAgent(agent),
      }));
    }
    if (category === 'channel') {
      return channels.filter(channel => channel.kind !== 'dm').map(channel => ({
        // The row's icon is already a '#', so the name goes without one.
        key: `channel:${channel.id}`, label: channel.name, unread: channel.unread,
        icon: <ConversationIcon channel={channel} />, pick: () => onPickChannel(channel),
      }));
    }
    // A person's direct message; yours is the one with yourself.
    const dmOf = person => channels.find(channel => channel.kind === 'dm'
      && (person.you ? channel.selfDm : channel.id === person.dmChannelId));
    return people.map(person => ({
      key: `person:${person.id}`, label: personLabel(person), unread: dmOf(person)?.unread,
      icon: <ConversationIcon person={person} />, pick: () => onPickPerson(person),
    }));
  }, [category, agents, channels, people, onPickAgent, onPickChannel, onPickPerson]);

  const currentKey = current.agent ? `agent:${current.agent.id}`
    : current.person ? `person:${current.person.id}`
    : current.channel ? `channel:${current.channel.id}`
    : null;
  const kind = CATEGORIES.find(item => item.id === category);
  // An agent by its own name rather than its chat's title, a channel without the
  // '#' its icon already draws.
  const currentName = current.agent?.name ?? current.channel?.name ?? current.label;
  const chosen = category === currentCategory;

  return (
    <div className={`${styles.picker} ${compact ? styles.compact : ''}`}>
      <DropUp
        id="cli-target-kind"
        className={styles.kind}
        open={openList === 'kind'}
        onOpenChange={next => setOpenList(next ? 'kind' : null)}
        trigger={<CategoryIcon id={category} />}
        triggerLabel={`Talk to: ${kind.label}`}
        rows={CATEGORIES.map(item => ({
          key: item.id, label: item.label, unread: unreadIn[item.id], icon: <span className={styles.kindIcon}><CategoryIcon id={item.id} /></span>,
        }))}
        selectedKey={category}
        onPick={(row) => {
          setCategory(row.key);
          // Straight on to which one, unless the kind was the one already shown.
          if (row.key !== category || !chosen) requestAnimationFrame(() => setOpenList('which'));
        }}
      />
      <DropUp
        id="cli-target-which"
        className={styles.which}
        open={openList === 'which'}
        onOpenChange={next => setOpenList(next ? 'which' : null)}
        trigger={chosen
          ? <><ConversationIcon agent={current.agent} channel={current.channel} person={current.person} label={current.label} /><span className={styles.label}>{currentName}</span></>
          : <span className={`${styles.label} ${styles.placeholder}`}>Choose…</span>}
        triggerLabel={`Which ${kind.label.toLowerCase()}`}
        rows={choices}
        selectedKey={chosen ? currentKey : null}
        onPick={row => row.pick()}
        filter={kind.find}
        empty={kind.none}
      />
    </div>
  );
}
