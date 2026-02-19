from pathlib import Path

from rovot.policy.approvals import ApprovalManager


def test_create_and_resolve(tmp_path: Path):
    mgr = ApprovalManager(tmp_path / "approvals.json")
    a = mgr.create(
        tool_name="exec.run", summary="run ls", session_id="s1", tool_arguments={"command": "ls"}
    )
    assert a.status == "pending"
    assert mgr.resolve(a.id, "allow", resolved_by="test")
    assert mgr.get(a.id).status == "allow"  # type: ignore[union-attr]
