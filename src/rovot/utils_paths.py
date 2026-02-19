from __future__ import annotations

import os
from pathlib import Path


class WorkspacePathError(ValueError):
    pass


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except Exception:
        return False


def resolve_in_workspace(workspace: Path, user_path: str) -> Path:
    if "\x00" in user_path:
        raise WorkspacePathError("NUL byte in path")
    p = Path(user_path)
    if p.is_absolute() or (os.name == "nt" and p.drive):
        raise WorkspacePathError("Absolute paths are not allowed")
    ws = workspace.expanduser().resolve()
    candidate = (ws / p).resolve(strict=False)
    if not _is_within(ws, candidate):
        raise WorkspacePathError("Path escapes workspace")
    cur = candidate
    for parent in [cur] + list(cur.parents):
        if parent == ws:
            break
        if parent.exists():
            real_parent = parent.resolve()
            if not _is_within(ws, real_parent):
                raise WorkspacePathError("Symlink escape detected")
    return candidate
