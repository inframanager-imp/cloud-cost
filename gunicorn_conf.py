"""
Gunicorn configuration — starts background schedulers in one worker process only.
The if __name__ == '__main__' block in app.py never runs under gunicorn, so we
bootstrap schedulers here via the post_fork hook instead.
"""
import os
import threading
import time
import uuid

# ── Server settings (mirror the CMD args so they can live in one place) ─────
bind    = "0.0.0.0:5000"
workers = 4
threads = 2
timeout = 300

# ── Scheduler bootstrap ───────────────────────────────────────────────────────

_LOCK_PATH = os.path.join(os.getenv("DATA_DIR", "/app/data"), ".scheduler_owner.pid")

# Generated once when gunicorn's master process imports this file (before any
# fork()), so every worker of THIS boot inherits the same value via copy-on-write.
# _LOCK_PATH lives on a host-mounted volume and survives container restarts, but
# PIDs don't mean anything across restarts -- a fresh container gets its own PID
# namespace starting from low numbers, so a stale lock's PID (e.g. "7") is almost
# guaranteed to coincidentally belong to a real, live worker after any restart
# (gunicorn's own workers get assigned exactly those low numbers). That made the
# old PID-only liveness check a false positive on essentially every restart,
# permanently blocking the scheduler from ever claiming ownership again. Tagging
# the lock with a boot-unique ID sidesteps the namespace collision entirely: a
# lock from a different boot is stale by definition, regardless of what its PID
# looks like now.
_BOOT_ID = uuid.uuid4().hex


def _read_lock():
    """Return (pid, boot_id) from the lock file, or None if missing/unparseable
    (including the old pre-boot-ID format, which we can't verify and treat as
    stale outright)."""
    try:
        with open(_LOCK_PATH) as fh:
            raw = fh.read().strip()
        pid_str, boot_id = raw.split(":", 1)
        return int(pid_str), boot_id
    except (FileNotFoundError, ValueError):
        return None


def _clean_stale_lock():
    """Remove the lock file if it's from a previous container boot, or if it's
    from this boot but the owning PID is no longer alive."""
    parsed = _read_lock()
    if parsed is None:
        # Missing, or an old-format lock we can't verify -- if a file is there
        # at all, it must be stale (nothing legitimate writes the old format
        # anymore), so clear it.
        try:
            os.unlink(_LOCK_PATH)
        except OSError:
            pass
        return
    pid, boot_id = parsed
    if boot_id != _BOOT_ID:
        # Different boot entirely -- the PID means nothing to us, stale by definition.
        try:
            os.unlink(_LOCK_PATH)
        except OSError:
            pass
        return
    try:
        os.kill(pid, 0)  # same boot, so a real liveness check is meaningful here
    except ProcessLookupError:
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
        os.write(fd, f"{os.getpid()}:{_BOOT_ID}".encode())
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
            if _app.cur_import_state.get("enabled"):
                _app._schedule_next_cur_import()
                print(f"[Scheduler] CUR auto-import timer started (worker {os.getpid()})")
            if _app.openai_auto_sync_state.get("enabled"):
                _app._schedule_next_openai_auto_sync()
                print(f"[Scheduler] OpenAI auto-sync timer started (worker {os.getpid()})")
        except Exception as exc:
            print(f"[Scheduler] Startup error in worker {os.getpid()}: {exc}")

    threading.Thread(target=_start, daemon=True).start()


def worker_exit(server, worker):
    """Remove the lock file when the owning worker exits so a new worker can take over."""
    try:
        parsed = _read_lock()
        if parsed and parsed[0] == worker.pid and parsed[1] == _BOOT_ID:
            os.unlink(_LOCK_PATH)
            print(f"[Scheduler] Owner worker {worker.pid} exited — lock released")
    except Exception:
        pass
