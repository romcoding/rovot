from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from rovot.internal_model import MODELS_DIR, get_internal_provider
from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/models/internal", tags=["models-internal"])

CATALOG = [
    {
        "name": "Llama 3.2 3B (Q4_K_M)",
        "filename": "llama-3.2-3b-instruct-q4_k_m.gguf",
        "size_gb": 2.0,
        "ram_required_gb": 4,
        "description": "Fast general-purpose model. Good for most tasks.",
        "hf_url": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    },
    {
        "name": "Llama 3.1 8B (Q4_K_M)",
        "filename": "llama-3.1-8b-instruct-q4_k_m.gguf",
        "size_gb": 4.7,
        "ram_required_gb": 8,
        "description": "Better reasoning and instruction following.",
        "hf_url": "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    },
    {
        "name": "Qwen 2.5 7B (Q4_K_M)",
        "filename": "qwen2.5-7b-instruct-q4_k_m.gguf",
        "size_gb": 4.4,
        "ram_required_gb": 8,
        "description": "Strong on coding and multilingual tasks.",
        "hf_url": "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
    },
    {
        "name": "Llama 3.2 1B (Q4_K_M)",
        "filename": "llama-3.2-1b-instruct-q4_k_m.gguf",
        "size_gb": 0.7,
        "ram_required_gb": 2,
        "description": "Ultra-fast. For low-RAM machines or quick tasks.",
        "hf_url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    },
]


@router.get("/available")
async def list_available(
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict[str, Any]:
    """List .gguf files available in ~/.rovot/models/."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    files = [f.name for f in MODELS_DIR.glob("*.gguf") if f.is_file()]
    return {"models": sorted(files)}


@router.get("/loaded")
async def get_loaded(
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict[str, Any]:
    """Return the name of the currently loaded model, or null."""
    provider = get_internal_provider()
    return {
        "loaded": provider.loaded_model_name(),
        "loading": provider.is_loading(),
    }


class LoadRequest(BaseModel):
    model_filename: str
    n_ctx: int = 4096
    n_gpu_layers: int = -1


@router.post("/load")
async def load_model(
    req: LoadRequest,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Load a .gguf model. Runs in a background thread to avoid blocking."""
    provider = get_internal_provider()

    if not provider.begin_load():
        raise HTTPException(status_code=409, detail="A model is already loading.")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODELS_DIR / req.model_filename
    if not model_path.exists():
        provider.end_load()
        raise HTTPException(
            status_code=404, detail=f"Model not found: {req.model_filename}"
        )

    async def _do_load():
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(
                None,
                lambda: provider.load_model(
                    req.model_filename,
                    n_ctx=req.n_ctx,
                    n_gpu_layers=req.n_gpu_layers,
                ),
            )
            await state.ws.broadcast(
                "model_load_complete", {"filename": req.model_filename}
            )
        except ImportError as exc:
            await state.ws.broadcast(
                "model_load_error", {"filename": req.model_filename, "error": str(exc)}
            )
        except Exception as exc:
            logger.exception("Failed to load model %s", req.model_filename)
            await state.ws.broadcast(
                "model_load_error", {"filename": req.model_filename, "error": str(exc)}
            )
        finally:
            provider.end_load()

    asyncio.create_task(_do_load())
    return {"status": "loading", "filename": req.model_filename}


@router.post("/unload")
async def unload_model(
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict[str, Any]:
    """Unload the current model and free memory."""
    provider = get_internal_provider()
    provider.unload_model()
    return {"status": "unloaded"}


@router.get("/catalog")
async def get_catalog(
    auth: AuthContext = Depends(get_auth_ctx),
) -> list[dict[str, Any]]:
    """Return a list of recommended models with download URLs."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = {f.name for f in MODELS_DIR.glob("*.gguf") if f.is_file()}
    result = []
    for entry in CATALOG:
        item = dict(entry)
        item["downloaded"] = entry["filename"] in downloaded
        result.append(item)
    return result


class DownloadRequest(BaseModel):
    filename: str
    hf_url: str


@router.post("/download")
async def download_model(
    req: DownloadRequest,
    auth: AuthContext = Depends(get_auth_ctx),
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Download a model file to ~/.rovot/models/ with WebSocket progress events."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dest = MODELS_DIR / req.filename

    if dest.exists():
        return {"status": "already_downloaded", "filename": req.filename}

    async def _do_download():
        try:
            async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
                async with client.stream("GET", req.hf_url) as response:
                    response.raise_for_status()
                    total = int(response.headers.get("content-length", 0))
                    downloaded = 0
                    with open(dest, "wb") as f:
                        async for chunk in response.aiter_bytes(chunk_size=65536):
                            f.write(chunk)
                            downloaded += len(chunk)
                            progress = downloaded / total if total else 0.0
                            await state.ws.broadcast(
                                "model_download_progress",
                                {
                                    "filename": req.filename,
                                    "progress": round(progress, 4),
                                    "bytes_downloaded": downloaded,
                                    "total_bytes": total,
                                },
                            )
            await state.ws.broadcast(
                "model_download_complete", {"filename": req.filename}
            )
        except Exception as exc:
            logger.exception("Download failed for %s", req.filename)
            if dest.exists():
                dest.unlink(missing_ok=True)
            await state.ws.broadcast(
                "model_download_error", {"filename": req.filename, "error": str(exc)}
            )

    asyncio.create_task(_do_download())
    return {"status": "downloading", "filename": req.filename}
