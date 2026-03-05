import asyncio

from rovot.config import ModelProviderMode
from rovot.providers.base import ChatResponse
from rovot.providers.router import ProviderRouter


class _FakeProvider:
    def __init__(self, name: str, fail: bool = False):
        self.name = name
        self.fail = fail

    async def chat(self, messages, tools=None):
        if self.fail:
            raise RuntimeError("boom")
        return ChatResponse(content=self.name)

    async def list_models(self):
        if self.fail:
            raise RuntimeError("boom")
        return [self.name]


def test_auto_mode_falls_back_to_cloud():
    router = ProviderRouter(
        local=_FakeProvider("local", fail=True),  # type: ignore[arg-type]
        cloud=_FakeProvider("cloud"),  # type: ignore[arg-type]
        mode=ModelProviderMode.AUTO,
        fallback_to_cloud=True,
    )
    resp = asyncio.run(router.chat([{"role": "user", "content": "hi"}]))
    assert resp.content == "cloud"


def test_local_mode_uses_local():
    router = ProviderRouter(
        local=_FakeProvider("local"),  # type: ignore[arg-type]
        cloud=_FakeProvider("cloud"),  # type: ignore[arg-type]
        mode=ModelProviderMode.LOCAL,
    )
    resp = asyncio.run(router.chat([{"role": "user", "content": "hi"}]))
    assert resp.content == "local"
