import asyncio
import json
import unittest

from local_llm import api


TOOLS = [{
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a local file",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["path"],
        },
    },
}]


class ToolProtocolTests(unittest.TestCase):
    @staticmethod
    def _collect_stream(response) -> str:
        async def collect() -> str:
            parts = []
            async for part in response.body_iterator:
                parts.append(part.decode() if isinstance(part, bytes) else part)
            return "".join(parts)

        return asyncio.run(collect())

    def test_qwen_xml_tool_call(self) -> None:
        content = (
            "<tool_call><function=read_file>"
            "<parameter=path>E:\\demo.txt</parameter>"
            "<parameter=limit>20</parameter>"
            "</function></tool_call>"
        )
        call = api.parse_tool_calls(content, TOOLS)[0]
        self.assertEqual(call["function"]["name"], "read_file")
        self.assertEqual(
            json.loads(call["function"]["arguments"]),
            {"path": "E:\\demo.txt", "limit": 20},
        )

    def test_qwen_json_tool_call(self) -> None:
        content = '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>'
        call = api.parse_tool_calls(content, TOOLS)[0]
        self.assertEqual(call["function"]["name"], "read_file")
        self.assertEqual(json.loads(call["function"]["arguments"]), {"path": "README.md"})

    def test_streaming_tool_call_is_openai_compatible(self) -> None:
        original = api.engine.stream_chat_completion

        def chunks(*_args, **_kwargs):
            yield {"choices": [{"delta": {"content": "<tool_"}, "finish_reason": None}]}
            yield {"choices": [{"delta": {"content": (
                "call><function=read_file><parameter=path>README.md</parameter>"
                "</function></tool_call>"
            )}, "finish_reason": None}]}
            yield {"choices": [{"delta": {}, "finish_reason": "stop"}]}

        api.engine.stream_chat_completion = chunks
        try:
            response = api.chat(api.ChatRequest(
                model=api.MODEL_ID,
                messages=[{"role": "user", "content": "read it"}],
                tools=TOOLS,
                stream=True,
            ))
            body = self._collect_stream(response)
        finally:
            api.engine.stream_chat_completion = original
        self.assertIn('"finish_reason": "tool_calls"', body)
        self.assertIn('"name": "read_file"', body)
        self.assertNotIn("<tool_call>", body)
        self.assertTrue(body.endswith("data: [DONE]\n\n"))

    def test_long_xml_tool_call_announces_function_before_arguments_finish(self) -> None:
        original = api.engine.stream_chat_completion

        def chunks(*_args, **_kwargs):
            yield {"choices": [{"delta": {"content": (
                "<tool_call><function=read_file><parameter=path>"
            )}, "finish_reason": None}]}
            yield {"choices": [{"delta": {"content": (
                "README.md</parameter></function></tool_call>"
            )}, "finish_reason": "stop"}]}

        api.engine.stream_chat_completion = chunks
        try:
            response = api.chat(api.ChatRequest(
                messages=[{"role": "user", "content": "read it"}],
                tools=TOOLS,
                stream=True,
            ))
            body = self._collect_stream(response)
        finally:
            api.engine.stream_chat_completion = original

        name_at = body.index('"name": "read_file"')
        arguments_at = body.index('"arguments": "{\\\"path\\\": \\"README.md\\\"}"')
        self.assertLess(name_at, arguments_at)
        self.assertIn('"finish_reason": "tool_calls"', body)

    def test_streaming_text_is_forwarded_as_multiple_chunks(self) -> None:
        original = api.engine.stream_chat_completion

        def chunks(*_args, **_kwargs):
            yield {"choices": [{"delta": {"content": "第一段"}, "finish_reason": None}]}
            yield {"choices": [{"delta": {"content": "第二段"}, "finish_reason": None}]}
            yield {"choices": [{"delta": {}, "finish_reason": "stop"}]}

        api.engine.stream_chat_completion = chunks
        try:
            response = api.chat(api.ChatRequest(
                messages=[{"role": "user", "content": "stream it"}],
                stream=True,
            ))
            body = self._collect_stream(response)
        finally:
            api.engine.stream_chat_completion = original

        self.assertIn('"content": "第一段"', body)
        self.assertIn('"content": "第二段"', body)
        self.assertLess(body.index("第一段"), body.index("第二段"))
        self.assertIn('"finish_reason": "stop"', body)

    def test_length_finish_reason_is_not_hidden(self) -> None:
        original = api._completion
        api._completion = lambda _request: ("unfinished", [], "length")
        try:
            response = api.chat(api.ChatRequest(
                messages=[{"role": "user", "content": "write a long answer"}],
            ))
        finally:
            api._completion = original
        self.assertEqual(response["choices"][0]["finish_reason"], "length")


if __name__ == "__main__":
    unittest.main()
