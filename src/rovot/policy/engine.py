"""Policy engine -- permission checks and scope gating.

Decides whether a given action is allowed, needs approval, or is denied
based on the active role, scopes, and the tool being invoked.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from rovot.policy.scopes import HIGH_RISK_TOOLS, Role, Scope


class Decision(str, Enum):
    ALLOW = "allow"
    NEEDS_APPROVAL = "needs_approval"
    DENY = "deny"


@dataclass
class PolicyResult:
    decision: Decision
    reason: str = ""


class PolicyEngine:
    def __init__(self, role: Role = Role.OPERATOR, scopes: frozenset[Scope] | None = None):
        self._role = role
        self._scopes = scopes or frozenset({Scope.READ, Scope.WRITE, Scope.EXEC})

    def check(self, tool_name: str) -> PolicyResult:
        """Evaluate whether *tool_name* may execute under the current policy."""

        if self._role == Role.VIEWER:
            if tool_name not in ("read_file", "list_dir", "web_fetch"):
                return PolicyResult(Decision.DENY, "Viewer role cannot execute write/exec tools.")

        if tool_name in HIGH_RISK_TOOLS:
            if Scope.APPROVE not in self._scopes:
                return PolicyResult(
                    Decision.NEEDS_APPROVAL,
                    f"'{tool_name}' is high-risk and requires explicit approval.",
                )

        if tool_name == "shell_exec" and Scope.EXEC not in self._scopes:
            return PolicyResult(Decision.DENY, "EXEC scope required for shell_exec.")

        return PolicyResult(Decision.ALLOW)
