import json
import subprocess
from pathlib import Path

import pytest

from nanoagent.uploaded.contract import ContractError
from nanoagent.uploaded.runner import RememberedAgents


def session(scratch: Path, identifier: str, name: str, contents: str, ended: str) -> Path:
    folder = scratch / 'sessions' / identifier
    binary = folder / 'workspace' / '.rush' / 'python' / 'bin' / name
    binary.parent.mkdir(parents=True)
    binary.write_text(contents)
    binary.chmod(0o755)
    (folder / 'session.json').write_text(json.dumps({'ended_at': ended}))
    return folder


def test_catalog_and_run_install_are_pinned_once_per_run(tmp_path):
    agents = RememberedAgents(tmp_path)
    agents.remember('aider')
    session(tmp_path, 'old', 'aider', 'old', '2026-01-01')
    latest = session(tmp_path, 'new', 'aider', 'new', '2026-01-02')
    assert agents.installed()['aider'] == latest / 'workspace'
    run = '00000000-0000-0000-0000-000000000001'
    first = agents.seed('aider', run, 1000)
    assert (first / 'python/bin/aider').read_text() == 'new'
    (latest / 'workspace/.rush/python/bin/aider').write_text('changed')
    assert agents.seed('aider', run, 1000) == first
    assert (first / 'python/bin/aider').read_text() == 'new'
    with pytest.raises(ContractError, match='no installed executable'):
        agents.seed('missing', '00000000-0000-0000-0000-000000000002', 1000)


def test_an_installation_larger_than_a_case_workspace_is_pinned_whole(tmp_path):
    """Regression: aider's 728 MB installation was copied into each case's 256 MB workspace, so every case of a `rush aider` run failed
    with a bare TooLarge worker error. The installation is pinned whole within the agent storage and mounted, never copied into a case."""
    agents = RememberedAgents(tmp_path)
    agents.remember('aider')
    session(tmp_path, 's', 'aider', 'x' * 5000, '2026-01-01')
    pinned = agents.seed('aider', '00000000-0000-0000-0000-000000000001', 10000)
    assert (pinned / 'python/bin/aider').read_text() == 'x' * 5000
    with pytest.raises(ContractError, match=r"aider's installation \(0 MB\) is larger than the computer's benchmark agent storage \(0 MB\)"):
        agents.seed('aider', '00000000-0000-0000-0000-000000000002', 1000)


def test_catalog_excludes_missing_unremembered_and_external_links(tmp_path):
    agents = RememberedAgents(tmp_path)
    agents.remember('aider')
    folder = session(tmp_path, 'session', 'other', 'x', '2026-01-01')
    binary = folder / 'workspace/.rush/python/bin/aider'
    binary.symlink_to('/bin/sh')
    assert agents.installed() == {}


def test_npm_link_executes_after_copy_and_storage_limit_is_explicit(tmp_path):
    agents = RememberedAgents(tmp_path)
    agents.remember('myagent')
    folder = tmp_path / 'sessions' / 's'
    npm = folder / 'workspace/.rush/npm'
    binary = npm / 'lib/node_modules/myagent/cli'
    binary.parent.mkdir(parents=True)
    binary.write_text('#!/bin/sh\nprintf "ran:%s" "$1"\n')
    binary.chmod(0o755)
    (npm / 'bin').mkdir()
    (npm / 'bin/myagent').symlink_to('../lib/node_modules/myagent/cli')
    (folder / 'session.json').write_text(json.dumps({'ended_at': '2026-01-01'}))
    assert 'myagent' in agents.installed()
    pinned = agents.seed('myagent', '00000000-0000-0000-0000-000000000001', 1000)
    assert subprocess.check_output([pinned / 'npm/bin/myagent', 'prompt'], text=True) == 'ran:prompt'
    with pytest.raises(ContractError, match='larger than the computer'):
        agents.seed('myagent', '00000000-0000-0000-0000-000000000002', 1)
    assert subprocess.check_output([pinned / 'npm/bin/myagent', 'again'], text=True) == 'ran:again'


def test_a_full_agent_storage_makes_room_by_dropping_idle_runs_installations_only(tmp_path):
    """Regression: every run kept its pinned copy for good, so once they filled the storage every later `rush` run failed on that computer.
    Room is made from installations unused for a day, never from one a case is using or a run used lately, and an evicted run is never
    pinned again from another session (which could hold another version of the agent)."""
    import os
    import time

    agents = RememberedAgents(tmp_path)
    agents.remember('aider')
    session(tmp_path, 's', 'aider', 'x' * 100, '2026-01-01')
    runs = [f'00000000-0000-0000-0000-00000000000{n}' for n in range(1, 5)]

    def seed(run):
        return agents.seed('aider', run, 250)  # room for two copies of about 105 bytes

    seed(runs[0])
    agents.release(runs[0])
    seed(runs[1])  # still running: its case is not released
    with pytest.raises(ContractError, match='used within the last day'):
        seed(runs[2])  # runs[0] is idle only minutes, runs[1] in use
    day_ago = time.time() - 2 * 24 * 3600
    for run in runs[:2]:
        os.utime(tmp_path / 'benchmark-installs' / run, (day_ago, day_ago))
    assert (seed(runs[2]) / 'python/bin/aider').read_text() == 'x' * 100
    kept = sorted(folder.name for folder in (tmp_path / 'benchmark-installs').iterdir() if folder.is_dir())
    assert kept == [runs[1], runs[2]]  # the idle one went; the one in use stayed though older
    (tmp_path / 'sessions/s/workspace/.rush/python/bin/aider').write_text('y' * 100)
    with pytest.raises(ContractError, match='removed to make room'):
        seed(runs[0])
