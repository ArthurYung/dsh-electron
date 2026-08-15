import unittest
import time
from unittest.mock import Mock

from local_llm.config import Settings
from local_llm.engine import ModelEngine


class MultimodalEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = ModelEngine(Settings(_env_file=None))

    def test_detects_image_url_content_parts(self) -> None:
        messages = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "描述图片"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
            ],
        }]
        self.assertTrue(self.engine._contains_images(messages))
        self.assertFalse(self.engine._contains_images([
            {"role": "user", "content": "纯文本"},
        ]))

    def test_no_think_is_added_to_multimodal_text_part(self) -> None:
        original = [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                {"type": "text", "text": "这是什么？"},
            ],
        }]
        prepared = self.engine._prepare_messages(original)

        self.assertEqual(prepared[0]["content"][1]["text"], "这是什么？\n/no_think")
        self.assertEqual(original[0]["content"][1]["text"], "这是什么？")

    def test_only_image_requests_use_vision_handler(self) -> None:
        model = Mock()
        handler = Mock(return_value={"choices": []})
        self.engine._vision_handler = handler
        image_kwargs = {
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}}],
            }],
        }
        self.engine._create_chat_completion(model, image_kwargs)
        handler.assert_called_once_with(llama=model, **image_kwargs)
        model.create_chat_completion.assert_not_called()

        text_kwargs = {"messages": [{"role": "user", "content": "hello"}]}
        self.engine._create_chat_completion(model, text_kwargs)
        model.create_chat_completion.assert_called_once_with(**text_kwargs)

    def test_abandoned_stream_does_not_keep_generation_lock(self) -> None:
        model = Mock()

        def chunks():
            yield {"choices": [{"delta": {"content": "first"}}]}
            yield {"choices": [{"delta": {"content": "second"}}]}

        model.create_chat_completion.return_value = chunks()
        self.engine._model = model
        stream = self.engine.stream_chat_completion([
            {"role": "user", "content": "hello"},
        ])
        self.assertEqual(next(stream)["choices"][0]["delta"]["content"], "first")
        stream.close()

        deadline = time.monotonic() + 1
        while self.engine._generation_lock.locked() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.engine._generation_lock.locked())

    def test_busy_model_times_out_instead_of_waiting_forever(self) -> None:
        engine = ModelEngine(Settings(
            _env_file=None,
            generation_queue_timeout=0.01,
        ))
        engine._model = Mock()
        engine._generation_lock.acquire()
        try:
            with self.assertRaisesRegex(TimeoutError, "仍在处理上一个请求"):
                engine.chat_completion([{"role": "user", "content": "hello"}])
        finally:
            engine._generation_lock.release()


if __name__ == "__main__":
    unittest.main()
