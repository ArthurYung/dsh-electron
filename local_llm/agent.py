import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / ".dsh" / "logs"
PROCESS_FILE = LOG_DIR / "agent-processes.json"
WEB_URL = "http://127.0.0.1:3080"


def _healthy(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except OSError:
        return False


def _wait_healthy(url: str, seconds: int) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if _healthy(url):
            return True
        time.sleep(0.25)
    return False


def _stop_tree(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def _runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    node_dir = Path(env.get("LOCALAPPDATA", "")) / "Programs" / "nodejs"
    env["PATH"] = f"{node_dir}{os.pathsep}{env.get('PATH', '')}"
    env["DSH_HOME"] = str(ROOT / ".dsh")
    env["DSH_CWD"] = str(ROOT)
    return env


def stop_saved_processes() -> None:
    if not PROCESS_FILE.is_file():
        print("没有发现由一键启动器管理的本地 Agent 进程。")
        return
    try:
        record = json.loads(PROCESS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"无法读取进程记录：{exc}") from exc

    for name in ("web", "api", "launcher"):
        pid = record.get(name)
        if not isinstance(pid, int) or pid == os.getpid():
            continue
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    PROCESS_FILE.unlink(missing_ok=True)
    print("本地 Agent 已关闭。")


def main() -> None:
    if "--stop" in sys.argv[1:]:
        stop_saved_processes()
        return
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    dsh = ROOT / "node_modules" / ".bin" / "dsh.cmd"
    if not dsh.is_file():
        raise SystemExit("找不到 DeepSeek Harness。请先在项目目录运行 npm install。")

    web_process: subprocess.Popen[bytes] | None = None
    try:
        if _healthy(WEB_URL):
            raise RuntimeError("端口 3080 已被占用。请先关闭旧的 Harness Web 进程。")

        command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(dsh), "web"]
        web_process = subprocess.Popen(command, cwd=ROOT, env=_runtime_env())
        PROCESS_FILE.write_text(
            json.dumps(
                {
                    "launcher": os.getpid(),
                    "api": None,
                    "web": web_process.pid,
                }
            ),
            encoding="utf-8",
        )
        if not _wait_healthy(WEB_URL, 15):
            raise RuntimeError("Harness Web 启动失败，请查看当前终端输出。")
        print(f"\nDeepSeek Harness 已启动：{WEB_URL}")
        print("默认模型：deepseek-official / deepseek-v4-flash")
        print("请在网页的 设置 -> 模型 中保存 DEEPSEEK_API_KEY；无需重启。")
        print("按 Ctrl+C 可关闭本次启动的 Harness。\n")
        web_process.wait()
    except KeyboardInterrupt:
        print("\n正在关闭 DeepSeek Harness…")
    finally:
        _stop_tree(web_process)
        PROCESS_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
