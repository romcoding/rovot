from __future__ import annotations

OPERATOR_READ = "operator.read"
OPERATOR_WRITE = "operator.write"
OPERATOR_APPROVALS = "operator.approvals"
OPERATOR_ADMIN = "operator.admin"

DEFAULT_ADMIN_SCOPES = [OPERATOR_READ, OPERATOR_WRITE, OPERATOR_APPROVALS, OPERATOR_ADMIN]
