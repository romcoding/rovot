from __future__ import annotations

import json
import os
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

import keyring


@dataclass
class SecretsStore:
    service: str
    fallback_path: Path
    use_keychain: bool = True
    _cache: dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _keychain_available_cache: bool | None = field(default=None, init=False, repr=False)

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
        if key in self._cache:
            return self._cache[key]
        if self.use_keychain:
            try:
                v = keyring.get_password(self.service, key)
                if v:
                    self._cache[key] = v
                    return v
            except Exception:
                pass
        v = self._fallback_load().get(key)
        if v:
            self._cache[key] = v
        return v

    def set(self, key: str, value: str) -> None:
        self._cache[key] = value
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
        self._cache.pop(key, None)
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
        if self._keychain_available_cache is not None:
            return self._keychain_available_cache
        try:
            keyring.get_password(self.service, "__probe__")
            self._keychain_available_cache = True
        except Exception:
            self._keychain_available_cache = False
        return self._keychain_available_cache
