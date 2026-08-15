from .config import settings
from .engine import engine


def main() -> None:
    history: list[dict[str, str]] = [
        {"role": "system", "content": settings.system_prompt}
    ]
    print("本地模型已就绪。输入 /clear 清空上下文，/exit 退出。")
    while True:
        try:
            prompt = input("\n你：").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not prompt:
            continue
        if prompt.lower() in {"/exit", "/quit"}:
            break
        if prompt.lower() == "/clear":
            history[:] = [{"role": "system", "content": settings.system_prompt}]
            print("上下文已清空。")
            continue

        history.append({"role": "user", "content": prompt})
        print("模型：", end="", flush=True)
        answer = ""
        finish_reason: str | None = None
        try:
            for chunk in engine.stream_chat_completion(history):
                choice = chunk["choices"][0]
                token = choice.get("delta", {}).get("content")
                if token:
                    answer += token
                    print(token, end="", flush=True)
                if choice.get("finish_reason"):
                    finish_reason = choice["finish_reason"]
        except Exception as exc:
            history.pop()
            print(f"\n运行失败：{exc}")
            continue
        print()
        if finish_reason == "length":
            print(
                "[提示：本次输出已达到上下文或客户端设置的长度上限。"
                "输入“继续”可接着生成。]"
            )
        history.append({"role": "assistant", "content": answer})


if __name__ == "__main__":
    main()
