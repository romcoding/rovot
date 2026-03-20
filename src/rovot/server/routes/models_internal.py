from __future__ import annotations

import asyncio
import logging
import platform
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from rovot.internal_model import MODELS_DIR, get_internal_provider
from rovot.policy.engine import AuthContext
from rovot.server.deps import AppState, get_auth_ctx, get_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/models/internal", tags=["models-internal"])

# Static fallback catalog — used when HF is unreachable.
# These are well-known, stable bartowski quantizations.
STATIC_CATALOG = [
    {
        "name": "Llama 3.2 3B (Q4_K_M)",
        "filename": "llama-3.2-3b-instruct-q4_k_m.gguf",
        "size_gb": 2.0,
        "ram_required_gb": 4,
        "description": "Fast general-purpose model. Good for most tasks.",
        "hf_repo": "bartowski/Llama-3.2-3B-Instruct-GGUF",
        "hf_url": "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    },
    {
        "name": "Llama 3.1 8B (Q4_K_M)",
        "filename": "llama-3.1-8b-instruct-q4_k_m.gguf",
        "size_gb": 4.7,
        "ram_required_gb": 8,
        "description": "Better reasoning and instruction following.",
        "hf_repo": "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
        "hf_url": "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    },
    {
        "name": "Llama 3.3 70B (Q2_K)",
        "filename": "llama-3.3-70b-instruct-q2_k.gguf",
        "size_gb": 26.0,
        "ram_required_gb": 32,
        "description": "Frontier open model. Requires powerful hardware.",
        "hf_repo": "bartowski/Llama-3.3-70B-Instruct-GGUF",
        "hf_url": "https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q2_K.gguf",
    },
    {
        "name": "Qwen 2.5 7B (Q4_K_M)",
        "filename": "qwen2.5-7b-instruct-q4_k_m.gguf",
        "size_gb": 4.4,
        "ram_required_gb": 8,
        "description": "Strong on coding and multilingual tasks.",
        "hf_repo": "Qwen/Qwen2.5-7B-Instruct-GGUF",
        "hf_url": "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
    },
    {
        "name": "Qwen 2.5 Coder 7B (Q4_K_M)",
        "filename": "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        "size_gb": 4.4,
        "ram_required_gb": 8,
        "description": "Specialised coding assistant. Excellent at code generation.",
        "hf_repo": "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
        "hf_url": "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    },
    {
        "name": "Gemma 3 4B (Q4_K_M)",
        "filename": "gemma-3-4b-instruct-q4_k_m.gguf",
        "size_gb": 2.5,
        "ram_required_gb": 6,
        "description": "Google Gemma 3 — compact and capable.",
        "hf_repo": "bartowski/gemma-3-4b-it-GGUF",
        "hf_url": "https://huggingface.co/bartowski/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
    },
    {
        "name": "Llama 3.2 1B (Q4_K_M)",
        "filename": "llama-3.2-1b-instruct-q4_k_m.gguf",
        "size_gb": 0.7,
        "ram_required_gb": 2,
        "description": "Ultra-fast. For low-RAM machines or quick tasks.",
        "hf_repo": "bartowski/Llama-3.2-1B-Instruct-GGUF",
        "hf_url": "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    },
]

# HuggingFace repos to scan for "latest GGUF" discovery
HF_SCAN_REPOS = [
    "bartowski/Llama-3.2-3B-Instruct-GGUF",
    "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    "bartowski/Llama-3.3-70B-Instruct-GGUF",
    "bartowski/gemma-3-4b-it-GGUF",
    "bartowski/gemma-3-12b-it-GGUF",
    "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
    "Qwen/Qwen2.5-7B-Instruct-GGUF",
    "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
    "Qwen/Qwen2.5-14B-Instruct-GGUF",
    "microsoft/Phi-4-GGUF",
]

_Q4_PREFERENCE = ["Q4_K_M", "Q4_K_S", "Q5_K_M", "Q4_0"]


def _pick_q4_file(files: list[str]) -> str | None:
    """Return the best Q4 quantization filename from a list of repo files."""
    for q in _Q4_PREFERENCE:
        for f in files:
            if f.endswith(".gguf") and q.lower() in f.lower():
                return f
    # Fallback: any gguf
    for f in files:
        if f.endswith(".gguf") and "Q4" in f.upper():
            return f
    return None


async def _fetch_hf_repo_files(repo: str) -> list[str]:
    """Fetch the file list from a HuggingFace repo (public API, no token needed)."""
    url = f"https://huggingface.co/api/models/{repo}"
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(url, headers={"Accept": "application/json"})
            if r.status_code != 200:
                return []
            data = r.json()
            siblings = data.get("siblings") or []
            return [s["rfilename"] for s in siblings if "rfilename" in s]
    except Exception:
        return []


def _detect_llama_cpp_status() -> dict[str, Any]:
    """Check whether llama-cpp-python is installed and report Metal/CUDA status."""
    try:
        import llama_cpp  # type: ignore[import]

        version = getattr(llama_cpp, "__version__", "unknown")
        # llama_cpp.llama_supports_gpu_offload() is available in recent builds
        supports_gpu = False
        try:
            supports_gpu = bool(llama_cpp.llama_supports_gpu_offload())
        except Exception:
            pass
        return {
            "installed": True,
            "version": version,
            "gpu_offload": supports_gpu,
            "backend": "metal"
            if (supports_gpu and platform.system() == "Darwin")
            else "cuda"
            if (supports_gpu and platform.system() != "Darwin")
            else "cpu",
        }
    except ImportError:
        is_apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
        install_cmd = (
            "CMAKE_ARGS='-DGGML_METAL=on' pip install llama-cpp-python"
            if is_apple_silicon
            else "pip install llama-cpp-python"
        )
        return {
            "installed": False,
            "version": None,
            "gpu_offload": False,
            "backend": None,
            "install_cmd": install_cmd,
            "is_apple_silicon": is_apple_silicon,
        }


@router.get("/status")
async def llama_cpp_status(
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict[str, Any]:
    """Return llama-cpp-python installation status and recommended install command."""
    return _detect_llama_cpp_status()


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
    # Check llama-cpp-python is actually installed before we even try
    cpp_status = _detect_llama_cpp_status()
    if not cpp_status["installed"]:
        install_cmd = cpp_status.get("install_cmd", "pip install llama-cpp-python")
        raise HTTPException(
            status_code=422,
            detail={
                "error": "llama_cpp_not_installed",
                "message": (
                    "Built-in inference requires llama-cpp-python. "
                    f"Install with: {install_cmd}"
                ),
                "install_cmd": install_cmd,
                "is_apple_silicon": cpp_status.get("is_apple_silicon", False),
            },
        )

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
            # This should be caught above, but just in case
            cpp_info = _detect_llama_cpp_status()
            await state.ws.broadcast(
                "model_load_error",
                {
                    "filename": req.model_filename,
                    "error": str(exc),
                    "install_cmd": cpp_info.get("install_cmd"),
                    "error_type": "llama_cpp_not_installed",
                },
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
    """Return the static catalog with download status."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = {f.name for f in MODELS_DIR.glob("*.gguf") if f.is_file()}
    result = []
    for entry in STATIC_CATALOG:
        item = dict(entry)
        item["downloaded"] = entry["filename"] in downloaded
        result.append(item)
    return result


@router.get("/catalog/scan")
async def scan_latest_models(
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict[str, Any]:
    """
    Scan HuggingFace repos for the latest available GGUF quantizations.
    Returns a list of models with direct download URLs — live data, not cached.
    """
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = {f.name for f in MODELS_DIR.glob("*.gguf") if f.is_file()}

    results = []

    async def _scan_repo(repo: str) -> dict[str, Any] | None:
        files = await _fetch_hf_repo_files(repo)
        if not files:
            return None
        chosen = _pick_q4_file(files)
        if not chosen:
            return None
        hf_url = f"https://huggingface.co/{repo}/resolve/main/{chosen}"
        # Derive a human-readable name from repo slug
        parts = repo.split("/")
        display_name = parts[-1].replace("-GGUF", "").replace("-", " ")
        # Strip bartowski/ prefix noise
        if parts[0].lower() == "bartowski":
            display_name = parts[1].replace("-GGUF", "").replace("-", " ")
        filename = chosen.lower()
        return {
            "name": display_name,
            "filename": filename,
            "hf_url": hf_url,
            "hf_repo": repo,
            "downloaded": filename in downloaded,
            "all_files": [f for f in files if f.endswith(".gguf")],
        }

    tasks = [_scan_repo(repo) for repo in HF_SCAN_REPOS]
    scan_results = await asyncio.gather(*tasks, return_exceptions=True)

    for r in scan_results:
        if isinstance(r, dict):
            results.append(r)

    return {
        "models": results,
        "scanned_repos": len(HF_SCAN_REPOS),
        "found": len(results),
    }


@router.get("/catalog/search")
async def search_hf_models(
    q: str,
    auth: AuthContext = Depends(get_auth_ctx),
) -> dict[str, Any]:
    """
    Search HuggingFace for GGUF models by keyword.
    Returns repos that contain .gguf files so the user can browse and add them.
    """
    if not q or len(q.strip()) < 2:
        return {"models": [], "error": "Query too short"}

    try:
        search_url = "https://huggingface.co/api/models"
        params = {
            "search": q,
            "filter": "gguf",
            "sort": "downloads",
            "direction": -1,
            "limit": 20,
        }
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(search_url, params=params)
            if r.status_code != 200:
                return {"models": [], "error": f"HuggingFace API returned {r.status_code}"}
            data = r.json()
    except Exception as exc:
        return {"models": [], "error": str(exc)}

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = {f.name for f in MODELS_DIR.glob("*.gguf") if f.is_file()}

    results = []
    for model in data:
        repo_id = model.get("modelId") or model.get("id") or ""
        if not repo_id:
            continue
        siblings = model.get("siblings") or []
        gguf_files = [s["rfilename"] for s in siblings if s.get("rfilename", "").endswith(".gguf")]
        if not gguf_files:
            continue
        chosen = _pick_q4_file(gguf_files) or gguf_files[0]
        filename = chosen.lower()
        results.append({
            "name": repo_id.split("/")[-1].replace("-GGUF", "").replace("-", " "),
            "repo_id": repo_id,
            "filename": filename,
            "hf_url": f"https://huggingface.co/{repo_id}/resolve/main/{chosen}",
            "downloads": model.get("downloads", 0),
            "likes": model.get("likes", 0),
            "gguf_files": gguf_files,
            "downloaded": filename in downloaded,
        })

    return {"models": results, "query": q}


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
