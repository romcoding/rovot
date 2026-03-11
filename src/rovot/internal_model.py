"""
Internal model provider using llama-cpp-python.

Loads .gguf models directly — no external server required.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)

MODELS_DIR = Path.home() / ".rovot" / "models"


class InternalModelProvider:
    """
    Wraps llama-cpp-python to provide OpenAI-compatible chat completions
    running entirely in-process.
    """

    def __init__(self):
        self._llm = None
        self._loaded_model_path: Optional[Path] = None
        self._loading = False

    def is_loaded(self) -> bool:
        return self._llm is not None

    def is_loading(self) -> bool:
        return self._loading

    def loaded_model_name(self) -> Optional[str]:
        if self._loaded_model_path:
            return self._loaded_model_path.name
        return None

    def load_model(
        self,
        model_filename: str,
        n_ctx: int = 4096,
        n_gpu_layers: int = -1,  # -1 = offload all layers to GPU
        verbose: bool = False,
    ) -> None:
        """
        Load a .gguf model from ~/.rovot/models/.

        Unloads any previously loaded model first.
        """
        try:
            from llama_cpp import Llama
        except ImportError as exc:
            raise ImportError(
                "Built-in inference requires llama-cpp-python. "
                "Install with: CMAKE_ARGS='-DGGML_METAL=on' pip install llama-cpp-python"
            ) from exc

        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        model_path = MODELS_DIR / model_filename

        if not model_path.exists():
            raise FileNotFoundError(f"Model not found: {model_path}")

        if self._llm is not None:
            logger.info("Unloading previous model before loading new one")
            self._llm = None
            self._loaded_model_path = None

        logger.info("Loading model: %s", model_path)
        self._llm = Llama(
            model_path=str(model_path),
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            verbose=verbose,
        )
        self._loaded_model_path = model_path
        logger.info("Model loaded successfully: %s", model_filename)

    def unload_model(self) -> None:
        """Unload the current model and free memory."""
        self._llm = None
        self._loaded_model_path = None
        logger.info("Model unloaded")

    async def chat_stream(
        self,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> AsyncIterator[str]:
        """
        Stream chat completion tokens as an async generator.

        Each yielded value is a text chunk string.
        """
        if self._llm is None:
            raise RuntimeError("No model loaded. Load a model first.")

        loop = asyncio.get_event_loop()

        # llama-cpp-python is synchronous — run in thread pool to avoid
        # blocking the FastAPI event loop
        def _run_sync():
            return self._llm.create_chat_completion(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )

        stream = await loop.run_in_executor(None, _run_sync)

        for chunk in stream:
            delta = chunk["choices"][0]["delta"]
            content = delta.get("content", "")
            if content:
                yield content

    async def chat_complete(
        self,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> str:
        """Non-streaming chat completion. Returns full response string."""
        chunks = []
        async for chunk in self.chat_stream(messages, temperature, max_tokens):
            chunks.append(chunk)
        return "".join(chunks)


# Module-level singleton — shared across the daemon
_provider = InternalModelProvider()


def get_internal_provider() -> InternalModelProvider:
    return _provider
