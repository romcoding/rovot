from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rovot.config import ModelProviderMode
from rovot.providers.base import ChatResponse
from rovot.providers.internal import InternalProvider
from rovot.providers.openai_compat import OpenAICompatProvider


class ProviderSelectionError(RuntimeError):
    pass


@dataclass
class ProviderRouter:
    local: OpenAICompatProvider
    cloud: OpenAICompatProvider | None
    mode: ModelProviderMode = ModelProviderMode.LOCAL
    fallback_to_cloud: bool = False
    internal: InternalProvider = field(default_factory=InternalProvider)

    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> ChatResponse:
        if self.mode == ModelProviderMode.INTERNAL:
            return await self.internal.chat(messages, tools)

        if self.mode == ModelProviderMode.CLOUD:
            if not self.cloud:
                raise ProviderSelectionError("Cloud provider is not configured")
            return await self.cloud.chat(messages, tools)

        if self.mode == ModelProviderMode.LOCAL:
            return await self.local.chat(messages, tools)

        # AUTO mode
        try:
            return await self.local.chat(messages, tools)
        except Exception:
            if not (self.fallback_to_cloud and self.cloud):
                raise
            return await self.cloud.chat(messages, tools)

    async def list_models(self) -> list[str]:
        if self.mode == ModelProviderMode.INTERNAL:
            return await self.internal.list_models()

        if self.mode == ModelProviderMode.CLOUD:
            if not self.cloud:
                return []
            return await self.cloud.list_models()

        if self.mode == ModelProviderMode.LOCAL:
            return await self.local.list_models()

        try:
            return await self.local.list_models()
        except Exception:
            if not (self.fallback_to_cloud and self.cloud):
                return []
            return await self.cloud.list_models()

    def supports_tools(self) -> bool:
        if self.mode == ModelProviderMode.INTERNAL:
            return self.internal.supports_tools()
        return True

    def supports_streaming(self) -> bool:
        return True

    def supports_vision(self) -> bool:
        return bool(self.cloud and self.mode == ModelProviderMode.CLOUD)
