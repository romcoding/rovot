from __future__ import annotations

from rovot.agent.tools.registry import Tool
from rovot.connectors.email_imap_smtp import EmailConnector


def register_email_tools(registry, email: EmailConnector | None) -> None:
    if email is None:
        return
    registry.register(
        Tool(
            name="email.list_recent",
            description="List recent email subjects via IMAP (requires consent_granted).",
            parameters={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50}
                },
                "required": [],
                "additionalProperties": False,
            },
            fn=lambda limit=10: email.list_recent_subjects(limit=limit),
        )
    )
    registry.register(
        Tool(
            name="email.send",
            description="Send an email via SMTP (high risk; requires approval).",
            parameters={
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["to", "subject", "body"],
                "additionalProperties": False,
            },
            fn=lambda to, subject, body: email.send_email(to=to, subject=subject, body=body),
            requires_write=True,
            requires_approval=True,
            approval_summary="Send an email",
        )
    )
