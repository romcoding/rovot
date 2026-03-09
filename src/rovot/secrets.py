from __future__ import annotations

import json
import os
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

import keyring

_UNSET = object()


@dataclass
class SecretsStore:
    service: str
    fallback_path: Path
    use_keychain: bool = True
    _cache: dict[str, str | None] = field(default_factory=dict, init=False, repr=False)
    _keychain_available_cache: bool | None = None
    _stats: dict[str, int] = field(default_factory=dict, init=False, repr=False)

    def _inc_stat(self, name: str) -> None:
        self._stats[name] = self._stats.get(name, 0) + 1

    def _inc_source(self, source: str) -> None:
        key = f"source.{source}"
        self._stats[key] = self._stats.get(key, 0) + 1

    def set_use_keychain(self, enabled: bool) -> None:
        self.use_keychain = enabled
        self._cache.clear()
        self._keychain_available_cache = None
        self._inc_stat("set_use_keychain")

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

    def get(
        self,
        key: str,
        *,
        source: str = "unknown",
        allow_keychain: bool = True,
    ) -> str | None:
        self._inc_stat("get")
        self._inc_source(source)
        cached = self._cache.get(key, _UNSET)
        if cached is not _UNSET:
            self._inc_stat("cache_hit")
            return cached
        self._inc_stat("cache_miss")
        if self.use_keychain and allow_keychain:
            try:
                self._inc_stat("keyring_get_password")
                v = keyring.get_password(self.service, key)
                self._cache[key] = v
                return v
            except Exception:
                self._inc_stat("keyring_get_password_error")
                pass
        elif self.use_keychain and not allow_keychain:
            self._inc_stat("keyring_get_password_skipped")
        v = self._fallback_load().get(key)
        self._inc_stat("fallback_get")
        self._cache[key] = v
        return v

    def set(self, key: str, value: str) -> None:
        self._inc_stat("set")
        self._cache[key] = value
        if self.use_keychain:
            try:
                self._inc_stat("keyring_set_password")
                keyring.set_password(self.service, key, value)
                return
            except Exception:
                self._inc_stat("keyring_set_password_error")
                pass
        d = self._fallback_load()
        d[key] = value
        self._inc_stat("fallback_set")
        self._fallback_save(d)

    def delete(self, key: str) -> None:
        self._inc_stat("delete")
        self._cache.pop(key, None)
        if self.use_keychain:
            try:
                self._inc_stat("keyring_delete_password")
                keyring.delete_password(self.service, key)
                return
            except Exception:
                self._inc_stat("keyring_delete_password_error")
                pass
        d = self._fallback_load()
        if key in d:
            del d[key]
            self._inc_stat("fallback_delete")
            self._fallback_save(d)

    @property
    def keychain_available(self) -> bool:
        self._inc_stat("keychain_available_check")
        if self._keychain_available_cache is not None:
            self._inc_stat("keychain_available_cache_hit")
            return self._keychain_available_cache
        if not self.use_keychain:
            self._keychain_available_cache = False
            return False
        try:
            self._inc_stat("keyring_get_keyring")
            keyring.get_keyring()
            self._keychain_available_cache = True
            return True
        except Exception:
            self._inc_stat("keyring_get_keyring_error")
            self._keychain_available_cache = False
            return False

    def debug_stats(self) -> dict[str, int]:
        return dict(self._stats)
