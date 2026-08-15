"""Make pip-installed NVIDIA runtime DLLs visible to Windows."""

import os
import site
import ctypes
from pathlib import Path


_dll_handles: list[object] = []


def configure_cuda_dlls() -> None:
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return

    candidates: list[Path] = []
    for root in site.getsitepackages():
        nvidia = Path(root) / "nvidia"
        if nvidia.is_dir():
            candidates.extend(nvidia.glob("*/bin"))

    for directory in candidates:
        if directory.is_dir():
            _dll_handles.append(os.add_dll_directory(str(directory)))

    # Windows may not resolve transitive CUDA dependencies from the added
    # directories reliably. Load them in dependency order before llama_cpp.
    site_roots = [Path(root) for root in site.getsitepackages()]
    relative_dlls = (
        Path("nvidia/cuda_runtime/bin/cudart64_12.dll"),
        Path("nvidia/cublas/bin/cublasLt64_12.dll"),
        Path("nvidia/cublas/bin/cublas64_12.dll"),
        Path("llama_cpp/lib/ggml-base.dll"),
        Path("llama_cpp/lib/ggml.dll"),
        Path("llama_cpp/lib/ggml-cpu.dll"),
        Path("llama_cpp/lib/ggml-cuda.dll"),
    )
    for relative in relative_dlls:
        for root in site_roots:
            dll = root / relative
            if dll.is_file():
                _dll_handles.append(ctypes.CDLL(str(dll)))
                break
