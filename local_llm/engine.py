from collections.abc import Iterator
from queue import SimpleQueue
from threading import Event, Lock, Thread
from typing import Any

from .config import Settings, settings
from .cuda_runtime import configure_cuda_dlls


class ModelEngine:
    def __init__(self, config: Settings = settings) -> None:
        self.config = config
        self._model: Any | None = None
        self._vision_handler: Any | None = None
        self._load_lock = Lock()
        self._vision_load_lock = Lock()
        self._generation_lock = Lock()

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is None:
                path = self.config.model_path.expanduser().resolve()
                if not path.is_file():
                    raise FileNotFoundError(
                        f"找不到 GGUF 模型：{path}\n"
                        "请把模型放进 models 目录，并在 .env 中设置 MODEL_PATH。"
                    )
                configure_cuda_dlls()
                from llama_cpp import Llama

                kwargs: dict[str, Any] = {
                    "model_path": str(path),
                    "n_ctx": self.config.n_ctx,
                    "n_gpu_layers": self.config.n_gpu_layers,
                    "verbose": False,
                }
                if self.config.n_threads:
                    kwargs["n_threads"] = self.config.n_threads
                self._model = Llama(**kwargs)
        return self._model

    def _load_vision_handler(self) -> Any:
        if self._vision_handler is not None:
            return self._vision_handler
        with self._vision_load_lock:
            if self._vision_handler is None:
                configured_path = self.config.mmproj_path
                if configured_path is None:
                    raise RuntimeError(
                        "当前服务没有配置视觉投影模型。请在 .env 中设置 MMPROJ_PATH。"
                    )
                path = configured_path.expanduser().resolve()
                if not path.is_file():
                    raise FileNotFoundError(
                        f"找不到视觉投影模型：{path}\n"
                        "请下载与主 GGUF 模型匹配的 mmproj，并在 .env 中设置 MMPROJ_PATH。"
                    )
                from llama_cpp.llama_chat_format import MTMDChatHandler

                self._vision_handler = MTMDChatHandler(
                    clip_model_path=str(path),
                    verbose=False,
                    use_gpu=self.config.mmproj_use_gpu,
                )
        return self._vision_handler

    @staticmethod
    def _contains_images(messages: list[dict[str, Any]]) -> bool:
        return any(
            isinstance(part, dict) and part.get("type") == "image_url"
            for message in messages
            for part in (
                message.get("content")
                if isinstance(message.get("content"), list)
                else []
            )
        )

    def _prepare_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        prepared: list[dict[str, Any]] = []
        for message in messages:
            copied = message.copy()
            if isinstance(copied.get("content"), list):
                copied["content"] = [
                    part.copy() if isinstance(part, dict) else part
                    for part in copied["content"]
                ]
            prepared.append(copied)
        if prepared and prepared[-1].get("role") == "user":
            content = prepared[-1].get("content")
            if isinstance(content, str):
                prepared[-1]["content"] = content.rstrip() + "\n/no_think"
            elif isinstance(content, list):
                for part in reversed(content):
                    if isinstance(part, dict) and part.get("type") == "text":
                        text = str(part.get("text", "")).rstrip()
                        part["text"] = f"{text}\n/no_think" if text else "/no_think"
                        break
                else:
                    content.append({"type": "text", "text": "/no_think"})
        return prepared

    def _create_chat_completion(
        self,
        model: Any,
        kwargs: dict[str, Any],
    ) -> Any:
        if self._contains_images(kwargs["messages"]):
            handler = self._load_vision_handler()
            return handler(llama=model, **kwargs)
        return model.create_chat_completion(**kwargs)

    def _acquire_generation_lock(self) -> None:
        if not self._generation_lock.acquire(
            timeout=self.config.generation_queue_timeout
        ):
            raise TimeoutError(
                "本地模型仍在处理上一个请求。请稍后重试；如果持续出现，重启 Agent。"
            )

    def stream_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Iterator[str]:
        for chunk in self.stream_chat_completion(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
        ):
            text = chunk["choices"][0].get("delta", {}).get("content")
            if text:
                yield text

    def stream_chat_completion(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
    ) -> Iterator[dict[str, Any]]:
        model = self._load()
        kwargs: dict[str, Any] = {
            "messages": self._prepare_messages(messages),
            "temperature": self.config.temperature if temperature is None else temperature,
            "max_tokens": self.config.max_tokens if max_tokens is None else max_tokens,
            "stream": True,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = tool_choice or "auto"
        # StreamingResponse may stop pulling a synchronous iterator as soon as
        # the browser disconnects. If llama.cpp runs in that same iterator,
        # generation pauses forever at a yield while still holding the model
        # lock. A producer thread exhausts (or cancels) the model iterator so a
        # closed Harness stream can never permanently block later requests.
        queue: SimpleQueue[Any] = SimpleQueue()
        finished = object()
        cancelled = Event()

        def produce() -> None:
            acquired = False
            try:
                self._acquire_generation_lock()
                acquired = True
                chunks = self._create_chat_completion(model, kwargs)
                for chunk in chunks:
                    if cancelled.is_set():
                        break
                    queue.put(chunk)
            except BaseException as exc:
                queue.put(exc)
            finally:
                if acquired:
                    self._generation_lock.release()
                queue.put(finished)

        producer = Thread(target=produce, name="llama-stream-producer", daemon=True)
        producer.start()
        try:
            while True:
                item = queue.get()
                if item is finished:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            cancelled.set()

    def chat_completion(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        model = self._load()
        kwargs: dict[str, Any] = {
            "messages": self._prepare_messages(messages),
            "temperature": self.config.temperature if temperature is None else temperature,
            "max_tokens": self.config.max_tokens if max_tokens is None else max_tokens,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = tool_choice or "auto"
        self._acquire_generation_lock()
        try:
            return self._create_chat_completion(model, kwargs)
        finally:
            self._generation_lock.release()


engine = ModelEngine()
