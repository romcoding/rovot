from __future__ import annotations

import asyncio
import email
import imaplib
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any


@dataclass
class EmailConnector:
    consent_granted: bool
    username: str
    password: str
    imap_host: str
    imap_port: int
    smtp_host: str
    smtp_port: int
    smtp_from: str
    allow_from: list[str]

    async def list_recent_subjects(self, limit: int = 10) -> list[dict[str, Any]]:
        if not self.consent_granted:
            return [{"error": "Email consent not granted"}]

        def _run() -> list[dict[str, Any]]:
            M = imaplib.IMAP4_SSL(self.imap_host, self.imap_port)
            M.login(self.username, self.password)
            M.select("INBOX")
            typ, data = M.search(None, "ALL")
            if typ != "OK":
                return []
            ids = data[0].split()[-limit:]
            out: list[dict[str, Any]] = []
            for msg_id in reversed(ids):
                typ, msg_data = M.fetch(msg_id, "(RFC822)")
                if typ != "OK":
                    continue
                raw = msg_data[0][1]  # type: ignore[index]
                msg = email.message_from_bytes(raw)  # type: ignore[arg-type]
                out.append({"from": msg.get("From", ""), "subject": msg.get("Subject", "")})
            M.logout()
            return out

        return await asyncio.to_thread(_run)

    async def send_email(self, to: str, subject: str, body: str) -> str:
        if not self.consent_granted:
            return "Email consent not granted"
        msg = EmailMessage()
        msg["From"] = self.smtp_from or self.username
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)

        def _run() -> str:
            with smtplib.SMTP(self.smtp_host, self.smtp_port) as s:
                s.starttls()
                s.login(self.username, self.password)
                s.send_message(msg)
            return "sent"

        return await asyncio.to_thread(_run)
