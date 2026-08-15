import html
import json
import logging
import re
import time
import uuid
from collections.abc import Iterator
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .engine import engine

app = FastAPI(title="Local Qwen Agent API", version="0.2.0")
MODEL_ID = "qwen3.5-9b-local"
logger = logging.getLogger("uvicorn.error")

_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
_FUNCTION_RE = re.compile(r"<function=([^>]+)>\s*(.*?)\s*</function>", re.DOTALL)
_PARAMETER_RE = re.compile(r"<parameter=([^>]+)>\s*(.*?)\s*</parameter>", re.DOTALL)


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict[str, Any]] | None = None
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str = MODEL_ID
    messages: list[Message]
    temperature: float | None = Field(None, ge=0, le=2)
    max_tokens: int | None = Field(None, ge=1)
    max_completion_tokens: int | None = Field(None, ge=1)
    stream: bool = False
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | dict[str, Any] | None = None


def _parameter_schema(tools: list[dict[str, Any]], function: str, parameter: str) -> dict[str, Any]:
    for tool in tools:
        definition = tool.get("function", {})
        if definition.get("name") == function:
            return definition.get("parameters", {}).get("properties", {}).get(parameter, {})
    return {}


def _coerce_parameter(value: str, schema: dict[str, Any]) -> Any:
    value = html.unescape(value.strip())
    expected = schema.get("type")
    if expected == "string":
        return value
    if expected in {"object", "array", "integer", "number", "boolean", "null"}:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            if expected == "integer":
                return int(value)
            if expected == "number":
                return float(value)
            if expected == "boolean":
                return value.lower() == "true"
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def parse_tool_calls(content: str, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for block in _TOOL_CALL_RE.findall(content):
        block = block.strip()
        try:
            payload = json.loads(block)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict) and isinstance(payload.get("name"), str):
            arguments = payload.get("arguments", payload.get("parameters", {}))
            calls.append(_tool_call(payload["name"], arguments))
            continue

        function_match = _FUNCTION_RE.search(block)
        if function_match is None:
            continue
        function_name = html.unescape(function_match.group(1).strip())
        arguments: dict[str, Any] = {}
        for parameter_name, raw_value in _PARAMETER_RE.findall(function_match.group(2)):
            parameter_name = html.unescape(parameter_name.strip())
            schema = _parameter_schema(tools, function_name, parameter_name)
            arguments[parameter_name] = _coerce_parameter(raw_value, schema)
        calls.append(_tool_call(function_name, arguments))
    return calls


def _tool_call(name: str, arguments: Any) -> dict[str, Any]:
    if isinstance(arguments, str):
        encoded_arguments = arguments
    else:
        encoded_arguments = json.dumps(arguments, ensure_ascii=False)
    return {
        "id": f"call_{uuid.uuid4().hex}",
        "type": "function",
        "function": {"name": name, "arguments": encoded_arguments},
    }


def _completion(request: ChatRequest) -> tuple[str, list[dict[str, Any]], str]:
    result = engine.chat_completion(
        [message.model_dump(exclude_none=True) for message in request.messages],
        temperature=request.temperature,
        max_tokens=request.max_completion_tokens or request.max_tokens,
        tools=request.tools,
        tool_choice=request.tool_choice,
    )
    choice = result["choices"][0]
    message = choice["message"]
    content = message.get("content") or ""
    calls = message.get("tool_calls") or parse_tool_calls(content, request.tools or [])
    if calls:
        content = _TOOL_CALL_RE.sub("", content).strip()
    finish_reason = "tool_calls" if calls else (choice.get("finish_reason") or "stop")
    return content, calls, finish_reason


def _chunk(
    completion_id: str,
    created: int,
    model: str,
    delta: dict[str, Any],
    finish: str | None = None,
) -> str:
    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _stream_events(
    request: ChatRequest,
    completion_id: str,
    created: int,
) -> Iterator[str]:
    """Translate llama.cpp chunks to OpenAI SSE without buffering normal text."""
    yield _chunk(completion_id, created, request.model, {"role": "assistant"})

    marker = "<tool_call>"
    pending_text = ""
    tool_markup = ""
    parsing_tool_markup = False
    native_tool_indexes: set[int] = set()
    announced_xml_tool_id: str | None = None
    announced_xml_tool_name: str | None = None
    content_chars = 0
    upstream_finish = "stop"

    try:
        chunks = engine.stream_chat_completion(
            [message.model_dump(exclude_none=True) for message in request.messages],
            temperature=request.temperature,
            max_tokens=request.max_completion_tokens or request.max_tokens,
            tools=request.tools,
            tool_choice=request.tool_choice,
        )
        for source_chunk in chunks:
            choice = source_chunk["choices"][0]
            delta = choice.get("delta", {})
            finish_reason = choice.get("finish_reason")
            if finish_reason:
                upstream_finish = finish_reason

            native_calls = delta.get("tool_calls")
            if native_calls:
                for call in native_calls:
                    index = int(call.get("index", 0))
                    native_tool_indexes.add(index)
                yield _chunk(
                    completion_id,
                    created,
                    request.model,
                    {"tool_calls": native_calls},
                )

            text = delta.get("content")
            if not text:
                continue
            if not request.tools:
                content_chars += len(text)
                yield _chunk(completion_id, created, request.model, {"content": text})
                continue

            if parsing_tool_markup:
                tool_markup += text
                if announced_xml_tool_id is None:
                    function_match = re.search(r"<function=([^>]+)>", tool_markup)
                    if function_match is not None:
                        announced_xml_tool_id = f"call_{uuid.uuid4().hex}"
                        announced_xml_tool_name = html.unescape(
                            function_match.group(1).strip()
                        )
                        yield _chunk(
                            completion_id,
                            created,
                            request.model,
                            {"tool_calls": [{
                                "index": 0,
                                "id": announced_xml_tool_id,
                                "type": "function",
                                "function": {
                                    "name": announced_xml_tool_name,
                                    "arguments": "",
                                },
                            }]},
                        )
                continue

            pending_text += text
            marker_at = pending_text.find(marker)
            if marker_at >= 0:
                visible = pending_text[:marker_at]
                if visible:
                    content_chars += len(visible)
                    yield _chunk(completion_id, created, request.model, {"content": visible})
                tool_markup = pending_text[marker_at:]
                pending_text = ""
                parsing_tool_markup = True
                continue

            # Keep only the possible prefix of a marker so a split
            # "<tool_" + "call>" is never leaked to the client.
            safe_length = max(0, len(pending_text) - len(marker) + 1)
            if safe_length:
                visible = pending_text[:safe_length]
                pending_text = pending_text[safe_length:]
                content_chars += len(visible)
                yield _chunk(completion_id, created, request.model, {"content": visible})
    except Exception:
        logger.exception("streaming completion failed model=%s", request.model)
        raise

    parsed_calls = parse_tool_calls(tool_markup, request.tools or []) if tool_markup else []
    if parsing_tool_markup and not parsed_calls:
        # Preserve model output if it looked like a tool call but was malformed.
        pending_text += tool_markup
    if pending_text:
        content_chars += len(pending_text)
        yield _chunk(completion_id, created, request.model, {"content": pending_text})

    for index, call in enumerate(parsed_calls):
        if (
            index == 0
            and announced_xml_tool_id is not None
            and call["function"]["name"] == announced_xml_tool_name
        ):
            delta_call = {
                "index": index,
                "function": {"arguments": call["function"]["arguments"]},
            }
        else:
            delta_call = {"index": index, **call}
        yield _chunk(
            completion_id,
            created,
            request.model,
            {"tool_calls": [delta_call]},
        )

    tool_call_count = len(parsed_calls) or len(native_tool_indexes)
    finish_reason = "tool_calls" if tool_call_count else upstream_finish
    logger.info(
        "stream completion model=%s finish_reason=%s tool_calls=%d content_chars=%d",
        request.model,
        finish_reason,
        tool_call_count,
        content_chars,
    )
    yield _chunk(completion_id, created, request.model, {}, finish_reason)
    yield "data: [DONE]\n\n"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_ID}


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "local"}],
    }


@app.post("/v1/chat/completions")
def chat(request: ChatRequest):
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    if request.stream:
        return StreamingResponse(
            _stream_events(request, completion_id, created),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        content, calls, finish_reason = _completion(request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    logger.info(
        "completion model=%s finish_reason=%s tool_calls=%d content_chars=%d",
        request.model,
        finish_reason,
        len(calls),
        len(content),
    )

    message: dict[str, Any] = {"role": "assistant", "content": content or None}
    if calls:
        message["tool_calls"] = calls
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": request.model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
    }


def main() -> None:
    import uvicorn

    uvicorn.run("local_llm.api:app", host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
