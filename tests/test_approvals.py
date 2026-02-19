from pathlib import Path

from rovot.policy.approvals import ApprovalManager


def test_create_and_resolve(tmp_path: Path):
    mgr = ApprovalManager(tmp_path / "approvals.json")
    a = mgr.create(
        tool_name="exec.run",
        summary="run ls",
        session_id="s1",
        tool_arguments={"command": "ls"},
        tool_call_id="call_123",
    )
    assert a.status == "pending"
    assert mgr.resolve(a.id, "allow", resolved_by="test")
    assert mgr.get(a.id).status == "allow"  # type: ignore[union-attr]
    assert mgr.consume(a.id)
    assert mgr.get(a.id).status == "consumed"  # type: ignore[union-attr]


def test_consume_rejects_non_allowed(tmp_path: Path):
    mgr = ApprovalManager(tmp_path / "approvals.json")
    a = mgr.create(
        tool_name="exec.run",
        summary="run ls",
        session_id="s1",
        tool_arguments={"command": "ls"},
    )
    assert not mgr.consume(a.id)  # still pending, not allowed


def test_consume_is_one_shot(tmp_path: Path):
    mgr = ApprovalManager(tmp_path / "approvals.json")
    a = mgr.create(
        tool_name="email.send",
        summary="send email",
        session_id="s2",
        tool_arguments={"to": "a@b.com", "subject": "hi", "body": "hello"},
        tool_call_id="call_456",
    )
    mgr.resolve(a.id, "allow", resolved_by="test")
    assert mgr.consume(a.id)
    assert not mgr.consume(a.id)  # already consumed, cannot replay
