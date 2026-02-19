"""Workspace guard -- confines file operations to a user-chosen directory.

All paths are resolved and validated against the workspace root before any
I/O proceeds, preventing directory-traversal escapes.
"""

from __future__ import annotations

from pathlib import Path


class WorkspaceViolation(Exception):
    """Raised when an operation attempts to escape the workspace."""


class WorkspaceGuard:
    def __init__(self, root: Path):
        self._root = root.resolve()
        if not self._root.is_dir():
            raise FileNotFoundError(f"Workspace directory does not exist: {self._root}")

    @property
    def root(self) -> Path:
        return self._root

    def resolve(self, relative: str) -> Path:
        """Resolve *relative* inside the workspace. Raises on traversal escape."""
        target = (self._root / relative).resolve()
        if not self._is_inside(target):
            raise WorkspaceViolation(
                f"Path '{relative}' resolves outside the workspace ({self._root})."
            )
        return target

    def _is_inside(self, path: Path) -> bool:
        try:
            path.relative_to(self._root)
            return True
        except ValueError:
            return False
