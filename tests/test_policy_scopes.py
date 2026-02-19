import pytest

from rovot.policy.approvals import ApprovalManager
from rovot.policy.engine import AuthContext, PolicyEngine
from rovot.policy.scopes import OPERATOR_WRITE


def test_write_scope_required(tmp_path):
    mgr = ApprovalManager(tmp_path / "a.json")
    p = PolicyEngine(mgr)
    ctx = AuthContext(token="t", scopes=[])
    with pytest.raises(PermissionError):
        p.enforce_write_scope(ctx)
    ctx2 = AuthContext(token="t", scopes=[OPERATOR_WRITE])
    p.enforce_write_scope(ctx2)
