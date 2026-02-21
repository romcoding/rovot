from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

import keyring


@dataclass
class SecretsStore:
    service: str
    fallback_path: Path
    use_keychain: bool = True

    def _fallback_load(self) -> dict[str, str]:
        if not self.fallback_path.exists():
            return {}
        try:
            return json.loads(self.fallback_path.read_text("utf-8"))
        except Exception:
            return {}

    def _fallback_save(self, data: dict[str, str]) -> None:
        self.fallback_path.parent.mkdir(parents=True, exist_ok=True)
        self.fallback_path.write_text(json.dumps(data, indent=2), "utf-8")
        try:
            os.chmod(self.fallback_path, 0o600)
        except Exception:
            pass

    def get(self, key: str) -> str | None:
        if self.use_keychain:
            try:
                v = keyring.get_password(self.service, key)
                if v:
                    return v
            except Exception:
                pass
        return self._fallback_load().get(key)

    def set(self, key: str, value: str) -> None:
        if self.use_keychain:
            try:
                keyring.set_password(self.service, key, value)
                return
            except Exception:
                pass
        d = self._fallback_load()
        d[key] = value
        self._fallback_save(d)

    def delete(self, key: str) -> None:
        if self.use_keychain:
            try:
                keyring.delete_password(self.service, key)
                return
            except Exception:
                pass
        d = self._fallback_load()
        if key in d:
            del d[key]
            self._fallback_save(d)

    @property
    def keychain_available(self) -> bool:
        if not self.use_keychain:
            return False
        try:
            keyring.get_password(self.service, "__probe__")
            return True
        except Exception:
            return False
