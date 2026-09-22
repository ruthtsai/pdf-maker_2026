"""Entry point: starts the local web server and opens the UI in the browser.

Everything runs on 127.0.0.1 only — no data ever leaves this machine.
"""

from __future__ import annotations

import threading
import webbrowser

import uvicorn

from web.server import app

HOST = "127.0.0.1"
PORT = 8765


def _open_browser() -> None:
    webbrowser.open(f"http://{HOST}:{PORT}")


def main() -> None:
    threading.Timer(1.0, _open_browser).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
