import React, {useCallback, useEffect, useMemo, useState} from 'react';
import styles from './channelMembers.module.css';

const labelOf = person => person.username || person.name || person.email || 'Someone';

function initials(person) {
  const words = labelOf(person).trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';
}

export default function ChannelMembers({channel, people, youId, chat, onClose}) {
  const [details, setDetails] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setDetails(await chat.channelDetails(channel.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [chat.channelDetails, channel.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const memberIds = useMemo(
    () => new Set((details?.members ?? []).map(person => person.id)),
    [details],
  );

  const changeMembership = async (person, isMember) => {
    setBusyId(person.id);
    setError(null);
    try {
      if (isMember) await chat.removeMember(channel.id, person.id);
      else await chat.addMember(channel.id, person.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="channel-members-title">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Channel members</span>
            <div id="channel-members-title" className={styles.title} role="heading" aria-level="2">
              # {channel.name}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close channel members">&times;</button>
        </header>

        <div className={styles.body}>
          <p className={styles.summary}>
            {details ? `${memberIds.size} of ${people.length} people in this channel` : 'Loading members…'}
          </p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <ul className={styles.list}>
            {people.map(person => {
              const isMember = memberIds.has(person.id);
              const isYou = person.id === youId || person.you;
              const canRemove = isMember && !isYou && details?.canAdminister;
              return (
                <li key={person.id} className={styles.person}>
                  <span className={styles.avatar}>{initials(person)}</span>
                  <span className={styles.identity}>
                    <span className={styles.name}>{labelOf(person)} {isYou && <small>(you)</small>}</span>
                    <span className={styles.meta}>{person.email || person.role || 'Workspace member'}</span>
                  </span>
                  {isYou ? (
                    <span className={styles.memberState}>Member</span>
                  ) : isMember ? (
                    canRemove
                      ? <button type="button" className={styles.remove} disabled={busyId === person.id} onClick={() => changeMembership(person, true)}>Remove</button>
                      : <span className={styles.memberState}>Member</span>
                  ) : (
                    <button type="button" className={styles.add} disabled={busyId === person.id || !details} onClick={() => changeMembership(person, false)}>Add</button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </div>
  );
}
