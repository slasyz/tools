"""Git helpers and worktree naming."""

import os
import re
import secrets
import string
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

SUFFIX_ALPHABET = string.ascii_lowercase + string.digits
SUFFIX_LENGTH = 6
SQUASH_HISTORY_LIMIT = 500
MergeStatus = Literal["merged", "squashed", "no", "-"]
PATCH_OPTIONS = (
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--no-relative",
    "--ignore-submodules=none",
    "--submodule=short",
    "--binary",
    "--full-index",
    "--unified=3",
)


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


def git_visible(*args: str, cwd: str | None = None, check: bool = True) -> bool:
    """Run git with all its output on stderr, so wt's stdout stays clean.

    If it fails, exit with git's status, or return False if check is False.
    Either way, git has already printed the reason.
    """
    result = subprocess.run(["git", *args], cwd=cwd, stdout=sys.stderr)
    if result.returncode != 0 and check:
        raise SystemExit(result.returncode)
    return result.returncode == 0


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


def default_branch() -> str | None:
    """Find the default branch without contacting a remote.

    Prefer origin/HEAD, then another remote's HEAD, then main or master.
    Use the local branch when present, otherwise the remote-tracking ref.
    """
    refs = dict(
        line.split("\t", 1)
        for line in git(
            "for-each-ref", "--format=%(refname)%09%(symref)", "refs/heads/", "refs/remotes/"
        ).splitlines()
    )
    remote_heads = sorted(
        ref for ref in refs if ref.startswith("refs/remotes/") and ref.endswith("/HEAD")
    )
    for head in ["refs/remotes/origin/HEAD", *remote_heads]:
        target = refs.get(head)
        if target and target in refs:
            branch = target.split("/", 3)[3]
            local = f"refs/heads/{branch}"
            return local if local in refs else target
    for branch in ("main", "master"):
        for ref in (f"refs/heads/{branch}", f"refs/remotes/origin/{branch}"):
            if ref in refs:
                return ref
    return None


def _merge_base(target: str, tip: str) -> str | None:
    result = subprocess.run(["git", "merge-base", target, tip], capture_output=True, text=True)
    if result.returncode == 1:
        return None  # Unrelated histories.
    if result.returncode != 0:
        raise WtError(result.stderr.strip() or "git merge-base failed")
    return result.stdout.strip()


def _patch_ids(*args: str, input: str | None = None) -> dict[str, str]:
    """Map commit IDs to stable patch IDs, keeping diffs as bytes for binary/non-UTF-8 files."""
    diff = subprocess.run(
        ["git", *args], input=input.encode() if input is not None else None, capture_output=True
    )
    if diff.returncode != 0:
        raise WtError(diff.stderr.decode(errors="replace").strip() or f"git {args[0]} failed")
    result = subprocess.run(["git", "patch-id", "--stable"], input=diff.stdout, capture_output=True)
    if result.returncode != 0:
        raise WtError(result.stderr.decode(errors="replace").strip() or "git patch-id failed")
    return {
        commit: patch
        for patch, commit in (line.split() for line in result.stdout.decode().splitlines())
    }


def _is_squashed(target: str, tip: str, history: dict[str, str | None]) -> bool:
    """Return whether tip's combined patch matches a recent non-merge commit on target.

    `history` maps commit IDs to patch IDs and is shared between calls.
    """
    base = _merge_base(target, tip)
    if base is None:
        return False
    patch = next(iter(_patch_ids("diff", *PATCH_OPTIONS, base, tip).values()), None)
    if patch is None:
        return False  # Empty changes are not evidence of a squash merge.
    candidates = git(
        "rev-list", "--no-merges", f"--max-count={SQUASH_HISTORY_LIMIT}", target, f"^{base}"
    ).splitlines()
    if missing := [commit for commit in candidates if commit not in history]:
        patches = _patch_ids(
            "show",
            "--stdin",
            "--no-walk",
            "--format=commit %H",
            *PATCH_OPTIONS,
            input="\n".join(missing) + "\n",
        )
        history.update((commit, patches.get(commit)) for commit in missing)
    return any(history[commit] == patch for commit in candidates)


def branch_merge_status(branches: list[str]) -> dict[str, MergeStatus]:
    """Check ancestry first, then look for a matching combined patch in recent history.

    Each commit's patch ID is computed at most once per call; nothing is written to disk.
    """
    if not branches:
        return {}
    target = default_branch()
    if target is None:
        return dict.fromkeys(branches, "-")
    target = git("rev-parse", "--verify", f"{target}^{{commit}}").strip()
    merged = set(
        git(
            "for-each-ref", f"--merged={target}", "--format=%(refname:lstrip=2)", "refs/heads/"
        ).splitlines()
    )
    history: dict[str, str | None] = {}
    # Branches with the same tip share a status.
    by_tip: dict[str, MergeStatus] = {}
    statuses: dict[str, MergeStatus] = {}
    for branch in branches:
        if branch in merged:
            statuses[branch] = "merged"
            continue
        tip = git("rev-parse", "--verify", f"refs/heads/{branch}^{{commit}}").strip()
        if tip not in by_tip:
            by_tip[tip] = "squashed" if _is_squashed(target, tip, history) else "no"
        statuses[branch] = by_tip[tip]
    return statuses


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


def new_worktree_path(project: str, branch: str, worktrees: list[Worktree]) -> Path:
    """Use <project>-<branch>, adding a random suffix only on a name collision."""
    root = wt_root()
    prefix = f"{project}-{sanitize(branch) or 'branch'}"
    reserved = {os.path.realpath(worktree.path) for worktree in worktrees}
    for attempt in range(101):
        name = prefix
        if attempt:
            suffix = "".join(secrets.choice(SUFFIX_ALPHABET) for _ in range(SUFFIX_LENGTH))
            name = f"{prefix}-{suffix}"
        path = root / name
        if not os.path.lexists(path) and os.path.realpath(path) not in reserved:
            return path
    raise WtError(f"could not find a free directory name for '{prefix}' in {root}")


def local_branch_exists(branch: str) -> bool:
    return git_ok("show-ref", "--verify", "--quiet", f"refs/heads/{branch}")


def remote_branch_exists(branch: str) -> bool:
    return any(
        git_ok("show-ref", "--verify", "--quiet", f"refs/remotes/{remote}/{branch}")
        for remote in git("remote").split()
    )
