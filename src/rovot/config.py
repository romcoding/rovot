"""Application configuration backed by Pydantic Settings.

Settings are loaded from environment variables prefixed with ``ROVOT_`` and
from an optional ``.env`` file in the working directory.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


class SecurityMode(str, Enum):
    """Tiered security modes for tool isolation."""

    WORKSPACE = "workspace"
    CONTAINER = "container"
    ELEVATED = "elevated"


class Settings(BaseSettings):
    model_config = {"env_prefix": "ROVOT_", "env_file": ".env", "env_file_encoding": "utf-8"}

    workspace_dir: Path = Field(
        default=Path.home() / "rovot-workspace",
        description="Root directory the agent may read/write. All file tools are confined here.",
    )

    host: str = Field(default="127.0.0.1", description="Bind address for the control plane.")
    port: int = Field(default=18789, description="Port for the control plane.")

    security_mode: SecurityMode = Field(
        default=SecurityMode.WORKSPACE,
        description="Active isolation tier: workspace | container | elevated.",
    )

    model_endpoint: str = Field(
        default="http://localhost:1234/v1",
        description="OpenAI-compatible base URL for the model backend.",
    )
    model_api_key: str = Field(
        default="",
        description="API key for cloud model providers (empty when using local inference).",
    )
    model_name: str = Field(
        default="",
        description="Model identifier (e.g. gpt-4o, local-model). Empty = let the provider pick.",
    )

    max_iterations: int = Field(
        default=25,
        description="Maximum tool-call iterations per agent turn before forcing a final answer.",
    )


def load_settings() -> Settings:
    """Load and return the current settings."""
    return Settings()
