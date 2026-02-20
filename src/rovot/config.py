from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings


class SecurityMode(str, Enum):
    WORKSPACE = "workspace"
    CONTAINER = "container"
    ELEVATED = "elevated"


class Settings(BaseSettings):
    model_config = {"env_prefix": "ROVOT_", "env_file": ".env", "env_file_encoding": "utf-8"}

    data_dir: Path = Field(default=Path.home() / ".rovot", description="Rovot data directory.")
    host: str = Field(default="127.0.0.1", description="Bind address for the control plane.")
    port: int = Field(default=18789, description="Port for the control plane.")
    workspace_dir: Path = Field(default=Path.home() / "rovot-workspace")


class ModelConfig(BaseModel):
    base_url: str = "http://localhost:1234/v1"
    model: str = ""
    api_key_secret: str = "model.api_key"


class EmailConnectorConfig(BaseModel):
    enabled: bool = False
    consent_granted: bool = False
    username: str = ""
    password_secret: str = "email.password"
    imap_host: str = ""
    imap_port: int = 993
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_from: str = ""
    allow_from: list[str] = Field(default_factory=list)


class ConnectorsConfig(BaseModel):
    filesystem_enabled: bool = True
    email: EmailConnectorConfig = Field(default_factory=EmailConnectorConfig)
    calendar_enabled: bool = False
    messaging_enabled: bool = False


class VoiceConfig(BaseModel):
    enabled: bool = False
    asr_base_url: str = ""
    asr_model: str = ""
    asr_api_key_secret: str = "voice.asr_api_key"


class AppConfig(BaseModel):
    onboarded: bool = False
    security_mode: SecurityMode = SecurityMode.WORKSPACE
    model: ModelConfig = Field(default_factory=ModelConfig)
    connectors: ConnectorsConfig = Field(default_factory=ConnectorsConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    max_iterations: int = 25


@dataclass
class ConfigStore:
    path: Path
    config: AppConfig = field(default_factory=AppConfig)

    def load(self) -> AppConfig:
        if self.path.exists():
            raw = json.loads(self.path.read_text("utf-8"))
            self.config = AppConfig.model_validate(raw)
        return self.config

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(self.config.model_dump_json(indent=2), "utf-8")

    def update_path(self, dotted: str, value: Any) -> None:
        parts = dotted.split(".")
        obj: Any = self.config
        for p in parts[:-1]:
            obj = getattr(obj, p)
        setattr(obj, parts[-1], value)
        self.save()
