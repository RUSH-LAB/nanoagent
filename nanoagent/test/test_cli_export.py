"""`nanoagent export`: its config, the query it sends RUSH, and the file it writes whole or not at all."""

import json
from pathlib import Path

import httpx
import pytest

from nanoagent.cli import export
from nanoagent.cli.export import DEFAULT_CONFIG, ExportCommandConfig, download, params
from nanoagent.runtime.config import load_config_args

LINES = [{"type": "run", "run_id": "r1"}, {"type": "chat", "session_id": "s1"}]
BODY = "".join(json.dumps(line) + "\n" for line in LINES).encode()


def test_the_config_takes_out_and_sends_only_the_filters_it_sets() -> None:
    cfg = load_config_args(ExportCommandConfig, [f"export_cfg={DEFAULT_CONFIG}", "out=traces.jsonl"])
    assert (cfg.out, params(cfg), cfg.lab) == ("traces.jsonl", {}, None)
    cfg = load_config_args(
        ExportCommandConfig, [f"export_cfg={DEFAULT_CONFIG}", "out=t.jsonl", "plugin=city-weather", "member=all", "since=2026-11-01"]
    )
    assert params(cfg) == {"plugin": "city-weather", "member": "all", "since": "2026-11-01"}


def client(handler) -> httpx.Client:
    return httpx.Client(base_url="http://rush", transport=httpx.MockTransport(handler))


def test_it_writes_the_export_and_counts_its_lines(tmp_path: Path) -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, content=BODY)

    out = tmp_path / "traces.jsonl"
    assert download(client(handler), {"member": "all"}, out) == 2
    assert seen[0].path == "/api/traces/export" and seen[0].params["member"] == "all"
    assert [json.loads(line) for line in out.read_text().splitlines()] == LINES
    assert not (tmp_path / "traces.jsonl.part").exists()


def test_a_refusal_says_why_and_writes_nothing(tmp_path: Path) -> None:
    out = tmp_path / "traces.jsonl"
    refused = client(lambda request: httpx.Response(403, json={"error": "Only platform administrators export other members' traces"}))
    with pytest.raises(SystemExit, match="403 Only platform administrators"):
        download(refused, {"member": "all"}, out)
    assert not out.exists()


def test_a_broken_transfer_leaves_no_file(tmp_path: Path) -> None:
    class Broken(httpx.SyncByteStream):
        def __iter__(self):
            yield BODY[:10]
            raise httpx.RemoteProtocolError("peer closed connection without sending complete message body")

    out = tmp_path / "traces.jsonl"
    with pytest.raises(httpx.RemoteProtocolError):
        download(client(lambda request: httpx.Response(200, stream=Broken())), {}, out)
    assert list(tmp_path.iterdir()) == []


def test_main_signs_in_with_rush_lab_s_connection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    folder = tmp_path / "lab" / "connections" / "localhost-3000-x"
    folder.mkdir(parents=True)
    (folder / "site").write_text("http://localhost:3000\n")
    (folder / "runner-credentials.json").write_text(json.dumps({"token": "t"}))
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers["authorization"])
        return httpx.Response(200, content=BODY)

    real = httpx.Client
    monkeypatch.setattr(export.httpx, "Client", lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(handler)))
    assert export.main([f"lab={tmp_path / 'lab'}", f"out={tmp_path / 'out' / 't.jsonl'}"]) == 0
    assert sent == ["Bearer t"] and "2 line(s)" in capsys.readouterr().out
