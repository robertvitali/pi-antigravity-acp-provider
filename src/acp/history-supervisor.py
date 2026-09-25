#!/usr/bin/python3
"""Opt-in cleanup for a profile exclusively used by Pi. Python 3.9+."""
import fcntl
import json
import os
import select
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager

COORD = '.pi-history-cleanup'
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
LOCK_WAIT = 5.0
CLEANUP_TIME = 2.0


class Deferred(Exception):
    pass


def diagnostic(reason):
    # Never echo paths, command arguments, credentials or history content.
    sys.stderr.write('Pi ACP history cleanup deferred: ' + reason + '\n')
    sys.stderr.flush()


def alive(identifier, group=False):
    try:
        os.kill(-identifier if group else identifier, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def open_directory(name, parent=None):
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    if os.fstat(fd).st_uid != os.getuid():
        os.close(fd)
        raise Deferred('directory ownership is uncertain')
    return fd


class Profile:
    def __init__(self):
        home = os.path.expanduser(os.environ.get('GEMINI_HOME') or '~/.gemini')
        self.path = os.path.abspath(os.path.join(home, 'antigravity-acp'))
        self.profile = open_directory(self.path)
        self.roots = {}
        try:
            try:
                os.mkdir(COORD, 0o700, dir_fd=self.profile)
            except FileExistsError:
                pass
            self.coord = open_directory(COORD, self.profile)
            if stat.S_IMODE(os.fstat(self.coord).st_mode) != 0o700:
                raise Deferred('coordination directory permissions are unsafe')
            self.lock = os.open('lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.coord)
            info = os.fstat(self.lock)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise Deferred('lock identity is unsafe')
        except Exception:
            os.close(self.profile)
            raise

    def verify(self):
        verify_identity(self.profile, self.path)
        verify_identity(self.coord, COORD, self.profile)
        verify_identity(self.lock, 'lock', self.coord)
        for name, fd in self.roots.items():
            verify_identity(fd, name, self.profile)

    @contextmanager
    def locked(self):
        deadline = time.monotonic() + LOCK_WAIT
        while True:
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Deferred('admission lock timed out; retry on next launch')
                time.sleep(0.025)
        try:
            self.verify()
            for name in ('conversations', 'brain'):
                if name not in self.roots:
                    try:
                        os.mkdir(name, 0o700, dir_fd=self.profile)
                    except FileExistsError:
                        pass
                    self.roots[name] = open_directory(name, self.profile)
            self.verify()
            yield
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)

    def write(self, name, group):
        self.verify()
        temporary = name + '.tmp'
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=self.coord)
        try:
            data = json.dumps({'version': 1, 'supervisor': os.getpid(), 'group': group}).encode()
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(temporary, name, src_dir_fd=self.coord, dst_dir_fd=self.coord)
            os.fsync(self.coord)
        except Exception:
            # An interrupted pre-rename write never authorizes START.
            raise

    def records(self):
        result = []
        for name in os.listdir(self.coord):
            if name == 'lock':
                continue
            stem = name.removesuffix('.tmp').removesuffix('.json')
            if len(stem) != 32 or any(c not in '0123456789abcdef' for c in stem) or name not in (stem + '.json', stem + '.json.tmp'):
                raise Deferred('unrecognized coordination record')
            info = os.stat(name, dir_fd=self.coord, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_size > 4096:
                raise Deferred('unsafe coordination record')
            if name.endswith('.tmp'):
                # We hold the lock: no writer can still be using a temporary.
                os.unlink(name, dir_fd=self.coord)
                continue
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.coord)
            try:
                with os.fdopen(fd, 'rb') as stream:
                    record = json.loads(stream.read(4097))
                if set(record) != {'version', 'supervisor', 'group'} or record['version'] != 1:
                    raise ValueError()
                if type(record['supervisor']) is not int or record['supervisor'] <= 1:
                    raise ValueError()
                if record['group'] is not None and (type(record['group']) is not int or record['group'] <= 1):
                    raise ValueError()
            except (ValueError, TypeError):
                raise Deferred('corrupt coordination record')
            result.append((name, record))
        return result

    def idle_cleanup(self, own=None):
        self.verify()
        records = self.records()
        active = False
        for name, record in records:
            if name != own and alive(record['supervisor']):
                active = True
            elif record['group'] is not None and alive(record['group'], group=True):
                raise Deferred('recorded runtime group remains present without a live owner; history retained')
        if active:
            return False
        deadline = time.monotonic() + CLEANUP_TIME
        for root in self.roots.values():
            clear_directory(root, deadline, self.verify)
        self.verify()
        for name, _record in records:
            os.unlink(name, dir_fd=self.coord)
        os.fsync(self.coord)
        return True

    def retire(self, name):
        with self.locked():
            if not self.idle_cleanup(own=name):
                # Our group is gone. Other owners retain responsibility.
                os.unlink(name, dir_fd=self.coord)
                os.fsync(self.coord)


def verify_identity(fd, name, parent=None):
    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    opened = os.fstat(fd)
    if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
        raise Deferred('filesystem identity changed; history retained')


def clear_directory(fd, deadline, verify):
    for name in os.listdir(fd):
        if time.monotonic() >= deadline:
            raise Deferred('cleanup deadline reached; retry on next launch')
        verify()
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = open_directory(name, fd)
            try:
                def verify_child():
                    verify()
                    verify_identity(child, name, fd)
                clear_directory(child, deadline, verify_child)
                verify_child()
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
        else:
            verify()
            # Unlink symlinks themselves, never their targets.
            os.unlink(name, dir_fd=fd)


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def drain(runner):
    # The supervisor never polls/reaps its gate before this function. Retaining
    # that child (even as a zombie) reserves its PID while group signals run.
    signal_group(runner.pid, signal.SIGTERM)
    time.sleep(0.7)
    signal_group(runner.pid, signal.SIGKILL)
    runner.wait(timeout=0.5)
    # After wait(), PGID may be reused. Only observe; never signal it again.
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        if not alive(runner.pid, group=True):
            return
        time.sleep(0.02)
    raise Deferred('runtime group remains present; history retained')


def gated_runner(control, status, command):
    # No ACP process exists before START. Neither private descriptor reaches
    # ACP, so EOF reliably means the supervisor has gone away.
    if os.read(control, 6) != b'START\n':
        return 0
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_args: None)
    child = subprocess.Popen(command, close_fds=True)
    def owner_lost():
        signal_group(os.getpgrp(), signal.SIGTERM)
        time.sleep(0.7)
        signal_group(os.getpgrp(), signal.SIGKILL)

    reported = False
    while True:
        code = child.poll()
        if code is not None and not reported:
            try:
                os.write(status, str(code if code >= 0 else 0).encode())
            except BrokenPipeError:
                owner_lost()
            reported = True
        readable, _, _ = select.select([control], [], [], 0.05)
        if readable and not os.read(control, 1):
            owner_lost()
        # Stay alive after ACP exits, reserving the group identity until the
        # supervisor finishes signaling descendants. It then reaps us.


def supervise(command):
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_args: stopped.set())
    parent = os.getppid()
    profile = Profile()
    name = uuid.uuid4().hex + '.json'
    runner = None
    control = None
    status = None
    drained = False
    try:
        with profile.locked():
            profile.idle_cleanup()
            if stopped.is_set() or os.getppid() != parent:
                return 0
            profile.write(name, None)
            reader, control = os.pipe()
            status, status_writer = os.pipe()
            try:
                runner = subprocess.Popen(
                    [sys.executable, '-I', '-B', os.path.abspath(__file__), '--runner', str(reader), str(status_writer), '--command'] + command,
                    stdin=subprocess.PIPE, pass_fds=(reader, status_writer), start_new_session=True,
                )
            finally:
                os.close(reader)
                os.close(status_writer)
            profile.write(name, runner.pid)
            if not stopped.is_set() and os.getppid() == parent:
                os.write(control, b'START\n')

        def forward_input():
            try:
                while True:
                    data = os.read(0, 4096)
                    if not data:
                        break
                    view = memoryview(data)
                    while view:
                        view = view[os.write(runner.stdin.fileno(), view):]
            except OSError:
                pass
            stopped.set()

        threading.Thread(target=forward_input, daemon=True).start()
        code = None
        while not stopped.is_set() and os.getppid() == parent:
            readable, _, _ = select.select([status], [], [], 0.025)
            if readable:
                payload = os.read(status, 32)
                code = int(payload) if payload else 75
                break
        # Set before calling: even an interrupted/erroring drain must never
        # retry signals after its wait() could have released the gate PID.
        drained = True
        drain(runner)
        profile.retire(name)
        return code if code is not None and code >= 0 else 0
    finally:
        if runner is not None and not drained:
            drained = True
            drain(runner)
        if control is not None:
            os.close(control)
        if status is not None:
            os.close(status)


def main():
    try:
        marker = sys.argv.index('--command')
        command = sys.argv[marker + 1:]
        if not command:
            raise ValueError()
        if len(sys.argv) > 1 and sys.argv[1] == '--runner':
            return gated_runner(int(sys.argv[2]), int(sys.argv[3]) if marker > 3 else None, command)
        return supervise(command)
    except Deferred as error:
        diagnostic(str(error))
        return 75
    except Exception:
        diagnostic('filesystem, process or configuration check failed; history retained')
        return 75


if __name__ == '__main__':
    sys.exit(main())
