from pathlib import Path

import pytest

from rovot.utils_paths import WorkspacePathError, resolve_in_workspace


def test_resolve_relative_ok(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    p = resolve_in_workspace(ws, "a/b.txt")
    assert str(p).startswith(str(ws))


def test_reject_absolute(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    with pytest.raises(WorkspacePathError):
        resolve_in_workspace(ws, str(tmp_path / "x.txt"))


def test_reject_traversal(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    with pytest.raises(WorkspacePathError):
        resolve_in_workspace(ws, "../evil.txt")
