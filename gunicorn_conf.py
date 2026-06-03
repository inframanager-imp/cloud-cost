"""
Gunicorn configuration — starts background schedulers in one worker process only.
The if __name__ == '__main__' block in app.py never runs under gunicorn, so we
bootstrap schedulers here via the post_fork hook instead.
"""
import os
import threading
import time

# ── Server settings (mirror the CMD args so they can live in one place) ─────
bind    = "0.0.0.0:5000"
workers = 4
threads = 2
timeout = 300

# ── Scheduler bootstrap ───────────────────────────────────────────────────────

_LOCK_PATH = os.path.join(os.getenv("DATA_DIR", "/app/data"), ".scheduler_owner.pid")


def _clean_stale_lock():
    """Remove lock file if the owning PID is no longer alive."""
    try:
        with open(_LOCK_PATH) as fh:
            pid = int(fh.read().strip())
        # Check if the process is still running
        os.kill(pid, 0)
    except (FileNotFoundError, ValueError):
        pass  # No lock file — nothing to clean
    except ProcessLookupError:
        # Owning process is dead — remove stale lock
        try:
            os.unlink(_LOCK_PATH)
        except OSError:
            pass


def post_fork(server, worker):
    """Called in each worker after it is forked from the master process."""
    _clean_stale_lock()

    # Race: first worker to create the lock file wins scheduler ownership.
    try:
        fd = os.open(_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        is_owner = True
    except FileExistsError:
        is_owner = False

    if not is_owner:
        return

    def _start():
        # Small delay lets the worker finish importing app before we call into it
        time.sleep(3)
        try:
            import app as _app
            if _app.auto_sync_state.get("enabled"):
                _app._schedule_next_auto_sync()
                print(f"[Scheduler] Auto-sync timer started (worker {os.getpid()})")
            if _app.activity_auto_sync_state.get("enabled"):
                _app._schedule_next_activity_auto_sync()
                print(f"[Scheduler] Activity auto-sync timer started (worker {os.getpid()})")
            if _app.EMAIL_SCHEDULER_ENABLED:
                _app._schedule_email_check()
                print(f"[Scheduler] Email scheduler started (worker {os.getpid()})")
        except Exception as exc:
            print(f"[Scheduler] Startup error in worker {os.getpid()}: {exc}")

    threading.Thread(target=_start, daemon=True).start()


def worker_exit(server, worker):
    """Remove the lock file when the owning worker exits so a new worker can take over."""
    try:
        with open(_LOCK_PATH) as fh:
            pid = int(fh.read().strip())
        if pid == worker.pid:
            os.unlink(_LOCK_PATH)
            print(f"[Scheduler] Owner worker {worker.pid} exited — lock released")
    except Exception:
        pass
