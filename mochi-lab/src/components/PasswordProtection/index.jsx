/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React, {useState} from 'react';
import {translate} from '@docusaurus/Translate';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

export default function PasswordProtection({
  children,
  password: correctPassword,
}) {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [inputPassword, setInputPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (inputPassword === correctPassword) {
      setIsUnlocked(true);
      setError('');
    } else {
      setError(
        translate({
          message: 'Incorrect password',
          id: 'passwordProtection.error.incorrect',
        }),
      );
    }
  };

  if (isUnlocked) {
    return <>{children}</>;
  }

  return (
    <div className={styles.container}>
      <form onSubmit={handleSubmit} className={styles.form}>
        <Heading as="h2">
          {translate({
            message: 'This content is password protected',
            id: 'passwordProtection.title',
          })}
        </Heading>
        <input
          type="password"
          value={inputPassword}
          onChange={(e) => setInputPassword(e.target.value)}
          placeholder={translate({
            message: 'Enter password',
            id: 'passwordProtection.placeholder',
          })}
          className={styles.input}
        />
        {error && <div className={styles.error}>{error}</div>}
        <button type="submit" className={styles.button}>
          {translate({
            message: 'Unlock',
            id: 'passwordProtection.button',
          })}
        </button>
      </form>
    </div>
  );
}
