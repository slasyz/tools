"""Git helpers and worktree naming."""

import os
import re
import secrets
import string
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SUFFIX_ALPHABET = string.ascii_lowercase + string.digits
SUFFIX_LENGTH = 6


class WtError(Exception):
    """An error reported to the user as `wt: <message>`."""


def git(*args: str, cwd: str | None = None) -> str:
    """Run git and return its stdout. Raise WtError with git's message on failure."""
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise WtError(result.stderr.strip() or f"git {args[0]} failed")
    return result.stdout


def git_ok(*args: str, cwd: str | None = None) -> bool:
    """Run git quietly and return whether it succeeded."""
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    return result.returncode == 0


def git_visible(*args: str, cwd: str | None = None) -> None:
    """Run git with all its output on stderr, so wt's stdout stays clean.

    Exit with git's status if it fails; git has already printed the reason.
    """
    result = subprocess.run(["git", *args], cwd=cwd, stdout=sys.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


@dataclass
class Worktree:
    path: str
    branch: str | None = None
    bare: bool = False
    detached: bool = False
    locked: bool = False
    prunable: bool = False

    @property
    def name(self) -> str:
        return os.path.basename(self.path)


def list_worktrees() -> list[Worktree]:
    """Return all worktrees of the current repository. The first one is the main worktree."""
    worktrees: list[Worktree] = []
    current: Worktree | None = None
    for line in git("worktree", "list", "--porcelain", "-z").split("\0"):
        if not line:
            current = None
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = Worktree(path=value)
            worktrees.append(current)
        elif current is None:
            continue
        elif key == "branch":
            current.branch = value.removeprefix("refs/heads/")
        elif key == "bare":
            current.bare = True
        elif key == "detached":
            current.detached = True
        elif key == "locked":
            current.locked = True
        elif key == "prunable":
            current.prunable = True
    if not worktrees:
        raise WtError("git returned no worktrees")
    return worktrees


def wt_root() -> Path:
    """Return the directory that holds all worktrees."""
    if root := os.environ.get("WT_ROOT"):
        return Path(root).expanduser().absolute()
    data_home = os.environ.get("XDG_DATA_HOME") or "~/.local/share"
    return (Path(data_home).expanduser() / "wt").absolute()


def same_path(a: str | Path, b: str | Path) -> bool:
    return os.path.realpath(a) == os.path.realpath(b)


def managed_worktrees(worktrees: list[Worktree]) -> list[Worktree]:
    """Return the worktrees that live directly in the wt root."""
    root = wt_root()
    return [w for w in worktrees if same_path(os.path.dirname(w.path), root)]


def find_managed(name: str) -> Worktree:
    for worktree in managed_worktrees(list_worktrees()):
        if worktree.name == name:
            return worktree
    raise WtError(f"no worktree named '{name}' in this project (see `wt ls`)")


def sanitize(text: str) -> str:
    """Make text safe for a directory name: 'feature/some---feature' -> 'feature-some-feature'."""
    return re.sub(r"[^A-Za-z0-9._]+", "-", text).strip("-.")


def project_name(main_worktree: Worktree) -> str:
    name = os.path.basename(main_worktree.path)
    if main_worktree.bare:
        name = name.removesuffix(".git")
    return sanitize(name) or "repo"


def new_worktree_path(project: str, branch: str) -> Path:
    """Return a free path named <project>-<branch>-<xxxxxx> in the wt root."""
    root = wt_root()
    prefix = f"{project}-{sanitize(branch) or 'branch'}"
    for _ in range(100):
        suffix = "".join(secrets.choice(SUFFIX_ALPHABET) for _ in range(SUFFIX_LENGTH))
        path = root / f"{prefix}-{suffix}"
        if not os.path.lexists(path):
            return path
    raise WtError(f"could not find a free directory name for '{prefix}' in {root}")


def local_branch_exists(branch: str) -> bool:
    return git_ok("show-ref", "--verify", "--quiet", f"refs/heads/{branch}")


def remote_branch_exists(branch: str) -> bool:
    return any(
        git_ok("show-ref", "--verify", "--quiet", f"refs/remotes/{remote}/{branch}")
        for remote in git("remote").split()
    )
