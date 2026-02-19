"""Scope and role definitions for the permission model."""

from __future__ import annotations

from enum import Enum


class Role(str, Enum):
    ADMIN = "admin"
    OPERATOR = "operator"
    VIEWER = "viewer"


class Scope(str, Enum):
    READ = "read"
    WRITE = "write"
    EXEC = "exec"
    APPROVE = "approve"
    ADMIN = "admin"


# Tools that always require explicit per-action approval regardless of role.
HIGH_RISK_TOOLS: frozenset[str] = frozenset({
    "shell_exec",
    "write_file",
    "delete_file",
    "send_email",
    "send_message",
})
