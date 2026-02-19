from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from rovot.policy.approvals import ApprovalManager, ApprovalRequired
from rovot.policy.scopes import OPERATOR_APPROVALS, OPERATOR_WRITE


@dataclass
class AuthContext:
    token: str
    scopes: list[str]


class PolicyEngine:
    def __init__(self, approvals: ApprovalManager):
        self._approvals = approvals

    def require_scope(self, ctx: AuthContext, scope: str) -> None:
        if scope not in ctx.scopes:
            raise PermissionError(f"Missing scope: {scope}")

    def enforce_write_scope(self, ctx: AuthContext) -> None:
        self.require_scope(ctx, OPERATOR_WRITE)

    def maybe_require_approval(
        self,
        *,
        ctx: AuthContext,
        session_id: str,
        tool_name: str,
        tool_args: dict[str, Any],
        summary: str,
        require: bool,
    ) -> None:
        if not require:
            return
        self.require_scope(ctx, OPERATOR_APPROVALS)
        approval = self._approvals.create(
            tool_name=tool_name,
            summary=summary,
            session_id=session_id,
            tool_arguments=tool_args,
        )
        raise ApprovalRequired(approval.id, f"Approval required: {summary}")
