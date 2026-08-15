from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    model_path: Path = Path("models/model.gguf")
    mmproj_path: Path | None = None
    # 视觉投影默认在 CPU 上运行，给语言模型和 KV cache 留出更多显存。
    mmproj_use_gpu: bool = False
    n_ctx: int = Field(4096, ge=512)
    n_gpu_layers: int = Field(0, ge=-1)
    n_threads: int = Field(0, ge=0)
    temperature: float = Field(0.7, ge=0, le=2)
    generation_queue_timeout: float = Field(60.0, gt=0)
    # -1 表示让 llama.cpp 使用上下文窗口中剩余的全部 token。
    max_tokens: int = Field(-1, ge=-1)
    system_prompt: str = "你是一个有帮助的中文助手。回答简洁、准确。"


settings = Settings()
