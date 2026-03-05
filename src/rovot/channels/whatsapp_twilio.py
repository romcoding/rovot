from __future__ import annotations

import hashlib
import hmac

from rovot.channels.base import ChannelAdapter, IncomingMessage


class TwilioWhatsAppAdapter(ChannelAdapter):
    """Minimal Twilio WhatsApp webhook parser with HMAC validation."""

    def __init__(self, auth_token: str, expected_url: str):
        self._auth_token = auth_token
        self._expected_url = expected_url

    def _validate(self, payload: dict, signature: str) -> bool:
        if not self._auth_token:
            return False
        s = self._expected_url + "".join(f"{k}{v}" for k, v in sorted(payload.items()))
        digest = hmac.new(self._auth_token.encode(), s.encode(), hashlib.sha1).digest()
        import base64

        expected = base64.b64encode(digest).decode()
        return hmac.compare_digest(expected, signature)

    def parse_incoming(self, payload: dict, headers: dict[str, str]) -> IncomingMessage:
        sig = headers.get("x-twilio-signature", "")
        if not self._validate(payload, sig):
            raise ValueError("Invalid Twilio signature")
        return IncomingMessage(
            user_id=str(payload.get("From", "unknown")),
            text=str(payload.get("Body", "")).strip(),
            channel="whatsapp",
        )
