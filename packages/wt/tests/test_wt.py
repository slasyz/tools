import io
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from wt import output
from wt import repo as repo_helpers
from wt.cli import HELP
from wt.repo import MergeStatus, sanitize

GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


class Env:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.root = tmp / "wt-root"
        self.env = {**os.environ, **GIT_ENV, "WT_ROOT": str(self.root)}

    def git(self, *args: str, cwd: Path) -> str:
        result = subprocess.run(
            ["git", *args], cwd=cwd, env=self.env, capture_output=True, text=True, check=True
        )
        return result.stdout.strip()

    def wt(self, *args: str, cwd: Path, ok: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, "-m", "wt", *args],
            cwd=cwd,
            env=self.env,
            capture_output=True,
            text=True,
        )
        if ok:
            assert result.returncode == 0, result.stderr
        return result

    def make_repo(self, name: str) -> Path:
        repo = self.tmp / name
        repo.mkdir()
        self.git("init", "-q", "-b", "main", cwd=repo)
        (repo / "file.txt").write_text("hello\n")
        self.git("add", ".", cwd=repo)
        self.git("commit", "-q", "-m", "init", cwd=repo)
        return repo


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


@pytest.fixture
def repo(env: Env) -> Path:
    return env.make_repo("myproj")


def add(env: Env, repo: Path, *args: str) -> Path:
    path = Path(env.wt("add", *args, cwd=repo).stdout.strip())
    assert path.is_dir()
    return path


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("feature/some---feature", "feature-some-feature"),
        ("main", "main"),
        ("/weird//name/", "weird-name"),
        ("fix_1.2", "fix_1.2"),
        ("ünïcode", "n-code"),
    ],
)
def test_sanitize(text: str, expected: str) -> None:
    assert sanitize(text) == expected


def test_add_new_branch(env: Env, repo: Path) -> None:
    result = env.wt("add", "-b", "feature/some---feature", cwd=repo)
    path = Path(result.stdout.strip())
    assert f"Created {path.name} on new branch feature/some---feature" in result.stderr
    assert "\x1b[" not in result.stderr
    assert path.parent == env.root
    assert path.name == "myproj-feature-some-feature"
    assert env.git("branch", "--show-current", cwd=path) == "feature/some---feature"
    assert env.git("rev-parse", "HEAD", cwd=path) == env.git("rev-parse", "HEAD", cwd=repo)


def test_add_new_branch_uses_current_head(env: Env, repo: Path) -> None:
    first = add(env, repo, "-b", "first")
    (first / "more.txt").write_text("more\n")
    env.git("add", ".", cwd=first)
    env.git("commit", "-q", "-m", "more", cwd=first)

    second = add(env, first, "-b", "second")
    assert env.git("rev-parse", "HEAD", cwd=second) == env.git("rev-parse", "HEAD", cwd=first)
    # Project name comes from the main worktree, not from the worktree we ran in.
    assert second.name == "myproj-second"


def test_add_new_branch_with_base(env: Env, repo: Path) -> None:
    base = env.git("rev-parse", "HEAD", cwd=repo)
    (repo / "file.txt").write_text("changed\n")
    env.git("commit", "-q", "-am", "change", cwd=repo)
    path = add(env, repo, "-b", "old", "--base", base)
    assert env.git("rev-parse", "HEAD", cwd=path) == base


def test_add_existing_branch(env: Env, repo: Path) -> None:
    env.git("branch", "existing", cwd=repo)
    path = add(env, repo, "existing")
    assert env.git("branch", "--show-current", cwd=path) == "existing"


def test_add_sanitized_name_collision(env: Env, repo: Path) -> None:
    first = add(env, repo, "-b", "feat/foo")
    second = add(env, repo, "-b", "feat-foo")
    assert first.name == "myproj-feat-foo"
    assert re.fullmatch(r"myproj-feat-foo-[a-z0-9]{6}", second.name)
    assert env.git("branch", "--show-current", cwd=first) == "feat/foo"
    assert env.git("branch", "--show-current", cwd=second) == "feat-foo"
    assert env.wt("dir", first.name, cwd=repo).stdout.strip() == str(first)
    assert env.wt("dir", second.name, cwd=repo).stdout.strip() == str(second)


@pytest.mark.parametrize("kind", ["directory", "file", "broken_symlink"])
def test_add_preserves_existing_path(env: Env, repo: Path, kind: str) -> None:
    env.root.mkdir()
    occupied = env.root / "myproj-feat"
    if kind == "directory":
        occupied.mkdir()
        (occupied / "keep.txt").write_text("keep\n")
    elif kind == "file":
        occupied.write_text("keep\n")
    else:
        occupied.symlink_to(env.tmp / "missing")

    path = add(env, repo, "-b", "feat")
    assert re.fullmatch(r"myproj-feat-[a-z0-9]{6}", path.name)
    if kind == "directory":
        assert (occupied / "keep.txt").read_text() == "keep\n"
    elif kind == "file":
        assert occupied.read_text() == "keep\n"
    else:
        assert occupied.is_symlink()
        assert occupied.readlink() == env.tmp / "missing"


def test_add_avoids_stale_worktree_name(env: Env, repo: Path) -> None:
    first = add(env, repo, "-b", "feat/foo")
    shutil.rmtree(first)
    second = add(env, repo, "-b", "feat-foo")
    assert re.fullmatch(r"myproj-feat-foo-[a-z0-9]{6}", second.name)
    listing = env.wt("ls", cwd=repo).stdout
    assert first.name in listing
    assert "[prunable]" in listing
    assert second.name in listing


def test_new_worktree_path_does_not_use_randomness_when_free(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WT_ROOT", str(env.root))

    def unexpected_choice(alphabet: str) -> str:
        raise AssertionError("no random suffix needed")

    monkeypatch.setattr(repo_helpers.secrets, "choice", unexpected_choice)
    assert repo_helpers.new_worktree_path("proj", "feat", []) == env.root / "proj-feat"


def test_new_worktree_path_retries_suffix_collisions(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WT_ROOT", str(env.root))
    env.root.mkdir()
    (env.root / "proj-feat").mkdir()
    (env.root / "proj-feat-aaaaaa").mkdir()
    choices = iter("aaaaaabbbbbb")
    monkeypatch.setattr(repo_helpers.secrets, "choice", lambda _: next(choices))
    assert repo_helpers.new_worktree_path("proj", "feat", []) == env.root / "proj-feat-bbbbbb"


def test_new_worktree_path_exhausted_collisions(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WT_ROOT", str(env.root))
    env.root.mkdir()
    (env.root / "proj-feat").mkdir()
    (env.root / "proj-feat-aaaaaa").mkdir()
    monkeypatch.setattr(repo_helpers.secrets, "choice", lambda _: "a")
    with pytest.raises(repo_helpers.WtError, match="could not find a free directory name"):
        repo_helpers.new_worktree_path("proj", "feat", [])


def test_add_missing_branch_fails(env: Env, repo: Path) -> None:
    result = env.wt("add", "nope", cwd=repo, ok=False)
    assert result.returncode == 1
    assert "does not exist" in result.stderr
    assert result.stdout == ""


def test_add_base_without_new_branch_fails(env: Env, repo: Path) -> None:
    env.git("branch", "existing", cwd=repo)
    result = env.wt("add", "existing", "--base", "main", cwd=repo, ok=False)
    assert result.returncode == 1
    assert "--base needs -b" in result.stderr


def test_add_remote_only_branch(env: Env) -> None:
    upstream = env.make_repo("upstream")
    env.git("branch", "remote-feature", cwd=upstream)
    clone = env.tmp / "clone"
    env.git("clone", "-q", str(upstream), str(clone), cwd=env.tmp)

    assert "remote-feature" in env.wt("__branches", cwd=clone).stdout.split()
    path = add(env, clone, "remote-feature")
    assert env.git("branch", "--show-current", cwd=path) == "remote-feature"
    upstream_ref = env.git("rev-parse", "--abbrev-ref", "remote-feature@{upstream}", cwd=clone)
    assert upstream_ref == "origin/remote-feature"


def test_ls_and_dir(env: Env, repo: Path) -> None:
    assert env.wt("ls", cwd=repo).stdout == ""
    path = add(env, repo, "-b", "feat")
    env.git("worktree", "add", "-q", str(env.tmp / "unmanaged"), "-b", "other", cwd=repo)

    lines = env.wt("ls", cwd=repo).stdout.splitlines()
    assert len(lines) == 1
    assert lines[0].split() == [path.name, "feat", "merged", str(path)]

    assert env.wt("__names", cwd=repo).stdout.split() == [path.name]
    assert env.wt("dir", path.name, cwd=repo).stdout.strip() == str(path)

    result = env.wt("dir", "unknown", cwd=repo, ok=False)
    assert result.returncode == 1
    assert "no worktree named" in result.stderr


@pytest.mark.parametrize("default", ["main", "master"])
def test_ls_merged_into_default_branch(env: Env, repo: Path, default: str) -> None:
    env.git("branch", "-m", default, cwd=repo)
    path = add(env, repo, "-b", "feat")
    env.git("commit", "--allow-empty", "-qm", "feature", cwd=path)
    # Running from the feature worktree must not use its HEAD as the target.
    assert env.wt("ls", cwd=path).stdout.split() == [path.name, "feat", "no", str(path)]

    env.git("merge", "--no-ff", "-m", "merge feature", "feat", cwd=repo)
    assert env.wt("ls", cwd=path).stdout.split() == [path.name, "feat", "merged", str(path)]


@pytest.mark.parametrize("remote", ["origin", "upstream"])
@pytest.mark.parametrize("local_default", [False, True])
def test_ls_remote_default_branch(env: Env, repo: Path, remote: str, local_default: bool) -> None:
    env.git("branch", "-m", "trunk", cwd=repo)
    path = add(env, repo, "-b", "feat")
    env.git("commit", "--allow-empty", "-qm", "feature", cwd=path)
    env.git("update-ref", f"refs/remotes/{remote}/trunk", "feat", cwd=repo)
    env.git("symbolic-ref", f"refs/remotes/{remote}/HEAD", f"refs/remotes/{remote}/trunk", cwd=repo)
    # A conventional branch name must not override the advertised default.
    env.git("branch", "main", "feat", cwd=repo)
    if not local_default:
        env.git("checkout", "--detach", cwd=repo)
        env.git("branch", "-D", "trunk", cwd=repo)

    expected = "no" if local_default else "merged"
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", expected, str(path)]


def test_ls_prefers_origin_default(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    env.git("commit", "--allow-empty", "-qm", "feature", cwd=path)
    for remote, commit in [("origin", "main"), ("another", "feat")]:
        env.git("update-ref", f"refs/remotes/{remote}/trunk", commit, cwd=repo)
        env.git(
            "symbolic-ref", f"refs/remotes/{remote}/HEAD", f"refs/remotes/{remote}/trunk", cwd=repo
        )
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", "no", str(path)]


def test_ls_unknown_default_branch(env: Env, repo: Path) -> None:
    env.git("branch", "-m", "trunk", cwd=repo)
    path = add(env, repo, "-b", "feat")
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", "-", str(path)]


def squash_feature(env: Env, repo: Path, *, merge_commit: bool = False) -> Path:
    path = add(env, repo, "-b", "feat")
    (path / "file.txt").write_text("feature\n")
    env.git("commit", "-qam", "feature", cwd=path)
    (path / "more.txt").write_text("more\n")
    env.git("add", ".", cwd=path)
    env.git("commit", "-qm", "more", cwd=path)
    (repo / "unrelated.txt").write_text("unrelated\n")
    env.git("add", ".", cwd=repo)
    env.git("commit", "-qm", "unrelated", cwd=repo)
    if merge_commit:
        env.git("checkout", "-qb", "landing", cwd=repo)
    env.git("merge", "--squash", "feat", cwd=repo)
    env.git("commit", "-qm", "squashed feature", cwd=repo)
    if merge_commit:
        env.git("checkout", "-q", "main", cwd=repo)
        env.git("merge", "--no-ff", "-m", "merge landing", "landing", cwd=repo)
    return path


@pytest.mark.parametrize("merge_commit", [False, True])
def test_ls_squash_merge(env: Env, repo: Path, merge_commit: bool) -> None:
    path = squash_feature(env, repo, merge_commit=merge_commit)
    assert env.wt("ls", cwd=path).stdout.split() == [path.name, "feat", "squashed", str(path)]
    # Detection works from repository refs even if the worktree directory is gone.
    shutil.rmtree(path)
    assert env.wt("ls", cwd=repo).stdout.split() == [
        path.name,
        "feat",
        "squashed",
        str(path),
        "[prunable]",
    ]


def test_ls_new_commits_after_squash(env: Env, repo: Path) -> None:
    path = squash_feature(env, repo)
    assert "squashed" in env.wt("ls", cwd=repo).stdout.split()
    (path / "more.txt").write_text("new unmerged work\n")
    env.git("commit", "-qam", "new work", cwd=path)
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", "no", str(path)]


def test_ls_partial_patch_is_not_squashed(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    (path / "file.txt").write_text("feature\n")
    env.git("commit", "-qam", "feature", cwd=path)
    (path / "more.txt").write_text("unmerged\n")
    env.git("add", ".", cwd=path)
    env.git("commit", "-qm", "more", cwd=path)
    (repo / "file.txt").write_text("feature\n")
    env.git("commit", "-qam", "only part of the feature", cwd=repo)
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", "no", str(path)]


def test_ls_squash_checks_outside_current_directory(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    for root in (path, repo):
        (root / "nested").mkdir()
        (root / "nested" / "shared.txt").write_text("same change\n")
        env.git("add", ".", cwd=root)
        env.git("commit", "-qm", "shared", cwd=root)
    (path / "file.txt").write_text("unmerged outside nested\n")
    env.git("commit", "-qam", "outside", cwd=path)
    env.git("config", "diff.relative", "true", cwd=repo)
    assert env.wt("ls", cwd=repo / "nested").stdout.split() == [path.name, "feat", "no", str(path)]


def test_ls_squash_does_not_ignore_submodules(env: Env, repo: Path) -> None:
    base = env.git("rev-parse", "HEAD", cwd=repo)
    path = add(env, repo, "-b", "feat")
    for root in (path, repo):
        (root / "file.txt").write_text("shared change\n")
        env.git("add", "file.txt", cwd=root)
        if root == path:
            env.git("update-index", "--add", "--cacheinfo", "160000", base, "dep", cwd=root)
        env.git("commit", "-qm", "shared", cwd=root)
    env.git("config", "diff.ignoreSubmodules", "all", cwd=repo)
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", "no", str(path)]


@pytest.mark.parametrize("binary", [False, True])
@pytest.mark.parametrize("matching", [False, True])
def test_ls_squash_non_utf8_files(env: Env, repo: Path, binary: bool, matching: bool) -> None:
    path = add(env, repo, "-b", "feat")
    prefix = b"\x00" if binary else b"\xff"
    for content in (b"first\n", b"final\n"):
        (path / "data").write_bytes(prefix + content)
        env.git("add", ".", cwd=path)
        env.git("commit", "-qm", "change data", cwd=path)
    env.git("merge", "--squash", "feat", cwd=repo)
    if not matching:
        (repo / "data").write_bytes(prefix + b"different\n")
        env.git("add", ".", cwd=repo)
    env.git("commit", "-qm", "squashed data", cwd=repo)
    expected = "squashed" if matching else "no"
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "feat", expected, str(path)]


def test_ls_unrelated_branch_history(env: Env, repo: Path) -> None:
    tree = env.git("rev-parse", "HEAD^{tree}", cwd=repo)
    commit = env.git("commit-tree", tree, "-m", "unrelated root", cwd=repo)
    env.git("branch", "unrelated", commit, cwd=repo)
    path = add(env, repo, "unrelated")
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "unrelated", "no", str(path)]


@pytest.fixture
def in_repo(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Run in-process git helpers inside the test repository."""
    monkeypatch.chdir(repo)
    for key, value in GIT_ENV.items():
        monkeypatch.setenv(key, value)


def test_squash_patch_ids_are_reused(
    env: Env, repo: Path, in_repo: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    squash_feature(env, repo)
    env.git("branch", "copy", "feat", cwd=repo)
    env.git("branch", "partial", "feat~1", cwd=repo)
    calls = []
    original = repo_helpers._patch_ids

    def track(*args: str, input: str | None = None) -> dict[str, str]:
        calls.append((args, input))
        return original(*args, input=input)

    monkeypatch.setattr(repo_helpers, "_patch_ids", track)
    assert repo_helpers.branch_merge_status(["feat", "copy", "partial"]) == {
        "feat": "squashed",
        "copy": "squashed",
        "partial": "no",
    }
    assert sum(args[0] == "show" for args, _ in calls) == 1
    assert sum(args[0] == "diff" for args, _ in calls) == 2


def test_squash_history_limit(
    env: Env, repo: Path, in_repo: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    squash_feature(env, repo)
    env.git("commit", "--allow-empty", "-qm", "later", cwd=repo)
    monkeypatch.setattr(repo_helpers, "SQUASH_HISTORY_LIMIT", 1)
    assert repo_helpers.branch_merge_status(["feat"]) == {"feat": "no"}
    monkeypatch.setattr(repo_helpers, "SQUASH_HISTORY_LIMIT", 2)
    assert repo_helpers.branch_merge_status(["feat"]) == {"feat": "squashed"}


def test_ls_home_path_keeps_dir_absolute(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    env.env["HOME"] = str(env.tmp)
    assert env.wt("ls", cwd=repo).stdout.split()[-1] == f"~/wt-root/{path.name}"
    assert env.wt("dir", path.name, cwd=repo).stdout.strip() == str(path)


def test_ls_detached(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    env.git("checkout", "--detach", cwd=path)
    assert env.wt("ls", cwd=repo).stdout.split() == [path.name, "(detached)", "-", str(path)]


def test_dir_without_name_prints_main_worktree(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    assert env.wt("dir", cwd=path).stdout.strip() == str(repo)
    assert env.wt("dir", cwd=repo).stdout.strip() == str(repo)


def test_remove_by_name(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    env.wt("remove", path.name, cwd=repo)
    assert not path.exists()
    assert env.wt("ls", cwd=repo).stdout == ""
    assert env.git("branch", "--list", "feat", cwd=repo) != ""


def test_remove_current(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    env.wt("remove", cwd=path)
    assert not path.exists()


def test_remove_outside_managed_worktree_fails(env: Env, repo: Path) -> None:
    result = env.wt("remove", cwd=repo, ok=False)
    assert result.returncode == 1
    assert "not inside a wt worktree" in result.stderr


def test_remove_dirty_needs_force(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    (path / "untracked.txt").write_text("x\n")
    assert env.wt("remove", path.name, cwd=repo, ok=False).returncode != 0
    assert path.exists()
    env.wt("remove", "--force", path.name, cwd=repo)
    assert not path.exists()


def test_remove_delete_branch(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "merged")
    env.wt("remove", "-D", path.name, cwd=repo)
    assert env.git("branch", "--list", "merged", cwd=repo) == ""


def test_remove_delete_unmerged_branch_needs_force(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "unmerged")
    (path / "new.txt").write_text("x\n")
    env.git("add", ".", cwd=path)
    env.git("commit", "-q", "-m", "work", cwd=path)

    result = env.wt("remove", "-D", path.name, cwd=repo, ok=False)
    assert result.returncode != 0
    assert not path.exists()
    assert env.git("branch", "--list", "unmerged", cwd=repo) != ""


def test_remove_delete_unmerged_branch_with_force(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "unmerged")
    (path / "new.txt").write_text("x\n")
    env.git("add", ".", cwd=path)
    env.git("commit", "-q", "-m", "work", cwd=path)
    env.wt("remove", "-f", "-D", path.name, cwd=repo)
    assert env.git("branch", "--list", "unmerged", cwd=repo) == ""


def commit_file(env: Env, path: Path, name: str) -> None:
    (path / name).write_text("x\n")
    env.git("add", ".", cwd=path)
    env.git("commit", "-qm", name, cwd=path)


def test_remove_merged(env: Env, repo: Path) -> None:
    squashed = squash_feature(env, repo)
    merged = add(env, repo, "-b", "merged")
    unmerged = add(env, repo, "-b", "unmerged")
    commit_file(env, unmerged, "work.txt")
    detached = add(env, repo, "-b", "detached")
    env.git("checkout", "-q", "--detach", cwd=detached)

    result = env.wt("remove", "--merged", cwd=repo)
    assert f"Removed {squashed.name}" in result.stderr
    assert f"Removed {merged.name}" in result.stderr
    assert not squashed.exists()
    assert not merged.exists()
    assert unmerged.exists()
    assert detached.exists()
    # Without -D, branches stay.
    assert env.git("branch", "--list", "feat", "merged", cwd=repo) != ""


def test_remove_merged_delete_branch_from_inside(env: Env, repo: Path) -> None:
    squashed = squash_feature(env, repo)
    merged = add(env, repo, "-b", "merged")
    unmerged = add(env, repo, "-b", "unmerged")
    commit_file(env, unmerged, "work.txt")

    env.wt("remove", "--merged", "-D", cwd=merged)
    assert not squashed.exists()
    assert not merged.exists()
    assert env.git("branch", "--list", "feat", "merged", cwd=repo) == ""
    assert env.git("branch", "--list", "unmerged", cwd=repo) != ""


def test_remove_merged_keeps_default_branch(env: Env, repo: Path) -> None:
    env.git("checkout", "-q", "--detach", cwd=repo)
    path = add(env, repo, "main")
    result = env.wt("remove", "--merged", "-D", cwd=repo)
    assert "No merged worktrees" in result.stderr
    assert path.exists()
    assert env.git("branch", "--list", "main", cwd=repo) != ""


def test_remove_merged_continues_after_failure(env: Env, repo: Path) -> None:
    dirty = add(env, repo, "-b", "dirty")
    (dirty / "untracked.txt").write_text("x\n")
    clean = add(env, repo, "-b", "clean")

    result = env.wt("remove", "--merged", "-D", cwd=repo, ok=False)
    assert result.returncode == 1
    assert f"could not remove: {dirty.name}" in result.stderr
    assert dirty.exists()
    assert not clean.exists()
    assert env.git("branch", "--list", "dirty", cwd=repo) != ""
    assert env.git("branch", "--list", "clean", cwd=repo) == ""

    env.wt("remove", "--merged", "-f", cwd=repo)
    assert not dirty.exists()


def test_remove_merged_unknown_default_branch(env: Env, repo: Path) -> None:
    env.git("branch", "-m", "trunk", cwd=repo)
    path = add(env, repo, "-b", "feat")
    result = env.wt("remove", "--merged", cwd=repo, ok=False)
    assert result.returncode == 1
    assert "could not find the default branch" in result.stderr
    assert path.exists()


def test_remove_merged_with_name_fails(env: Env, repo: Path) -> None:
    path = add(env, repo, "-b", "feat")
    result = env.wt("remove", "--merged", path.name, cwd=repo, ok=False)
    assert result.returncode == 1
    assert "--merged takes no <name>" in result.stderr
    assert path.exists()


def test_prune(env: Env, repo: Path) -> None:
    gone = add(env, repo, "-b", "gone")
    shutil.rmtree(gone)
    assert "[prunable]" in env.wt("ls", cwd=repo).stdout

    leftover = add(env, repo, "-b", "leftover")
    admin_dir = env.git("rev-parse", "--path-format=absolute", "--git-dir", cwd=leftover)
    shutil.rmtree(admin_dir)

    result = env.wt("prune", cwd=repo)
    assert result.stdout.splitlines() == [str(leftover)]
    assert env.wt("ls", cwd=repo).stdout == ""


@pytest.mark.parametrize("args", [["help"], ["-h"], ["--help"], ["add", "-h"]])
def test_help(env: Env, repo: Path, args: list[str]) -> None:
    result = env.wt(*args, cwd=repo)
    assert result.stdout == HELP
    for command in ["add", "ls", "dir", "cd", "remove", "prune", "init", "completion"]:
        assert f"\n  {command}" in result.stdout
    for flag in ["-b", "--base", "--force", "--delete-branch", "--merged"]:
        assert flag in result.stdout


def test_help_outside_repo(env: Env) -> None:
    assert env.wt("help", cwd=env.tmp).stdout == HELP


def test_not_a_repo(env: Env) -> None:
    result = env.wt("ls", cwd=env.tmp, ok=False)
    assert result.returncode == 1
    assert "not a git repository" in result.stderr


def test_unknown_command(env: Env, repo: Path) -> None:
    result = env.wt("frobnicate", cwd=repo, ok=False)
    assert result.returncode == 2
    assert "wt help" in result.stderr


@pytest.mark.parametrize("shell", ["zsh", "bash", "fish"])
@pytest.mark.parametrize("command", ["completion", "init"])
def test_shell_scripts_parse(env: Env, repo: Path, shell: str, command: str) -> None:
    if shutil.which(shell) is None:
        pytest.skip(f"{shell} not installed")
    script = env.wt(command, shell, cwd=repo).stdout
    subprocess.run([shell, "-n"], input=script, text=True, check=True)


def make_wt_bin(env: Env) -> Path:
    """Put a `wt` executable on a directory, so completion scripts can run `command wt`."""
    wt_bin = env.tmp / "bin"
    wt_bin.mkdir()
    (wt_bin / "wt").write_text(f'#!/bin/sh\nexec "{sys.executable}" -m wt "$@"\n')
    (wt_bin / "wt").chmod(0o755)
    return wt_bin


def test_bash_completion(env: Env, repo: Path) -> None:
    if shutil.which("bash") is None:
        pytest.skip("bash not installed")
    env.git("branch", "existing", cwd=repo)
    path = add(env, repo, "-b", "feat")
    script = env.wt("completion", "bash", cwd=repo).stdout
    bash_env = {**env.env, "PATH": f"{make_wt_bin(env)}:{env.env['PATH']}"}

    def complete(*words: str) -> list[str]:
        words_str = " ".join(f"'{w}'" for w in words)
        program = (
            f"{script}\nCOMP_WORDS=({words_str}); COMP_CWORD={len(words) - 1}; _wt;"
            ' printf "%s\\n" "${COMPREPLY[@]}"'
        )
        out = subprocess.run(
            ["bash", "-c", program],
            cwd=repo,
            env=bash_env,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return [line for line in out.splitlines() if line]

    assert "remove" in complete("wt", "")
    assert set(complete("wt", "add", "")) == {"existing", "feat", "main"}
    assert complete("wt", "add", "-b", "") == []
    assert "--base" in complete("wt", "add", "-")
    assert complete("wt", "remove", "") == [path.name]
    assert complete("wt", "dir", "") == [path.name]
    assert {"--delete-branch", "--merged"} <= set(complete("wt", "remove", "--"))
    assert complete("wt", "init", "") == ["zsh", "bash", "fish"]
    assert complete("wt", "add", "fe") == ["feat"]
    assert complete("wt", "add", "--base", "ma") == ["main"]

    # Ref names come from remotes, so completion must not run code in them.
    evil = "$(touch${IFS}pwned)"
    env.git("branch", evil, cwd=repo)
    assert evil in complete("wt", "add", "")
    assert evil in complete("wt", "add", "--base", "")
    assert not (repo / "pwned").exists()


def test_fish_completion(env: Env, repo: Path) -> None:
    if shutil.which("fish") is None:
        pytest.skip("fish not installed")
    env.git("branch", "existing", cwd=repo)
    path = add(env, repo, "-b", "feat")
    script = env.wt("completion", "fish", cwd=repo).stdout
    fish_env = {**env.env, "PATH": f"{make_wt_bin(env)}:{env.env['PATH']}"}

    def complete(line: str) -> list[str]:
        out = subprocess.run(
            ["fish", "--no-config", "-c", "source; complete -C $argv[1]", line],
            input=script,
            cwd=repo,
            env=fish_env,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return [entry.split("\t")[0] for entry in out.splitlines() if entry]

    assert "remove" in complete("wt ")
    assert set(complete("wt add ")) == {"existing", "feat", "main"}
    assert complete("wt add -b ") == []
    assert "--base" in complete("wt add --")
    assert "main" in complete("wt add -b x --base ")
    assert complete("wt remove ") == [path.name]
    assert complete("wt cd ") == [path.name]
    assert {"--delete-branch", "--merged"} <= set(complete("wt remove --"))
    assert set(complete("wt init ")) == {"zsh", "bash", "fish"}


# Each program adds a worktree, goes to the main worktree, goes back, then
# removes the worktree it is in. It prints the directory after each step.
SHELL_FUNCTION_PROGRAMS = {
    "bash": [
        "bash",
        "-c",
        '. "$0"; wt add -b feat 2>/dev/null && pwd && wt cd && pwd && cd "$OLDPWD"'
        " && wt remove 2>/dev/null && pwd",
    ],
    "zsh": [
        "zsh",
        "-f",
        "-c",
        '. "$0" 2>/dev/null; wt add -b feat 2>/dev/null && pwd && wt cd && pwd && cd "$OLDPWD"'
        " && wt remove 2>/dev/null && pwd",
    ],
    "fish": [
        "fish",
        "--no-config",
        "-c",
        "source $argv[1]; wt add -b feat 2>/dev/null; and pwd; and wt cd; and pwd; and cd -;"
        " and wt remove 2>/dev/null; and pwd",
    ],
}


@pytest.mark.parametrize("shell", ["bash", "zsh", "fish"])
def test_shell_function_changes_directory(env: Env, repo: Path, shell: str) -> None:
    if shutil.which(shell) is None:
        pytest.skip(f"{shell} not installed")
    script = env.tmp / f"init.{shell}"
    script.write_text(env.wt("init", shell, cwd=repo).stdout)
    shell_env = {**env.env, "PATH": f"{make_wt_bin(env)}:{env.env['PATH']}"}
    out = subprocess.run(
        [*SHELL_FUNCTION_PROGRAMS[shell], str(script)],
        cwd=repo,
        env=shell_env,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    main = os.path.realpath(repo)
    assert len(out) == 3, out
    assert os.path.realpath(Path(out[0]).parent) == os.path.realpath(env.root)
    assert [os.path.realpath(line) for line in out[1:]] == [main, main]


class FakeTerminal(io.StringIO):
    def isatty(self) -> bool:
        return True


ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture
def color_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.delenv("NO_COLOR", raising=False)


def test_help_in_terminal_is_colored_but_same_text(color_env: None) -> None:
    file = FakeTerminal()
    output.print_help(HELP, file=file)
    assert "\x1b[" in file.getvalue()
    assert ANSI.sub("", file.getvalue()) == HELP


def test_table_in_terminal(color_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "140")
    rows = [
        output.Row("proj-feat-abc123", "feat", "/wt/proj-feat-abc123"),
        output.Row("proj-x-def456", "(detached)", "/wt/proj-x-def456", True, ["prunable"]),
    ]
    file = FakeTerminal()
    output.worktree_table(rows, file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert "\x1b[" in file.getvalue()
    assert lines[0].split() == ["NAME", "BRANCH", "MERGED", "PATH"]
    assert lines[2].split() == [
        "proj-x-def456",
        "(detached)",
        "-",
        "/wt/proj-x-def456",
        "[prunable]",
    ]


def test_table_when_piped() -> None:
    rows = [output.Row("proj-x-def456", "(detached)", "/wt/x", True, ["prunable", "locked"])]
    file = io.StringIO()
    output.worktree_table(rows, file=file)
    assert file.getvalue() == "proj-x-def456  (detached)  -  /wt/x [prunable] [locked]\n"


@pytest.mark.parametrize("terminal", [False, True])
@pytest.mark.parametrize("merged", ["merged", "squashed", "no", "-"])
def test_table_merged_and_home_path(
    terminal: bool, merged: MergeStatus, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", "/home/me")
    rows = [output.Row("feat", "feat", "/home/me/wt/feat", merged=merged)]
    file = FakeTerminal() if terminal else io.StringIO()
    output.worktree_table(rows, file=file)
    text = ANSI.sub("", file.getvalue())
    assert merged in text.split()
    assert "~/wt/feat" in text
    assert "/home/me" not in text


@pytest.mark.parametrize("width", [24, 36, 44, 80])
def test_table_keeps_core_columns_aligned(width: int, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", str(width))
    row = output.Row(
        "proj-feature-abc123", "feature/login", "/wt/proj-feature-abc123", merged="merged"
    )
    file = FakeTerminal()
    output.worktree_table([row], file=file)
    text = ANSI.sub("", file.getvalue())
    lines = text.splitlines()
    for cell in (row.name, row.branch, "merged", row.path):
        assert any(cell in line for line in lines)
    assert "…" not in text
    if width == 24:
        assert lines == ["NAME", row.name, f"  ⑂ {row.branch}", "  ◇ merged", f"  ↳ {row.path}"]
    elif width == 36:
        assert lines[0].split() == ["NAME", "BRANCH"]
        assert lines[0].index("BRANCH") == lines[1].index(row.branch)
        assert lines[1:] == [f"{row.name}  {row.branch}", "  ◇ merged", f"  ↳ {row.path}"]
    elif width == 44:
        assert lines[0].split() == ["NAME", "BRANCH", "MERGED"]
        assert lines[1:] == [f"{row.name}  {row.branch}  merged", f"  ↳ {row.path}"]
        assert lines[0].index("BRANCH") == lines[1].index(row.branch)
        assert lines[0].index("MERGED") == lines[1].index("merged")
    else:
        assert len(lines) == 2
        assert lines[0].index("PATH") == lines[1].index(row.path)
    assert all(len(line) <= width for line in lines if "↳" not in line or width != 24)


def test_table_keeps_oversized_cells_intact(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "24")
    row = output.Row("x" * 100, "q" * 100, "/" + "z" * 100, merged="merged")
    file = FakeTerminal()
    output.worktree_table([row], file=file)
    text = ANSI.sub("", file.getvalue())
    lines = text.splitlines()
    assert lines[1] == row.name
    assert lines[2] == f"  ⑂ {row.branch}"
    assert lines[3] == "  ◇ merged"
    assert lines[4] == f"  ↳ {row.path}"
    for char in "xqz":
        assert text.count(char) == 100
    assert "…" not in text


def test_table_keeps_path_spaces_and_tags_together(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "40")
    row = output.Row("project-feature-abc123", "feature/login", "/wt/my project", tags=["locked"])
    file = FakeTerminal()
    output.worktree_table([row], file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert f"  ↳ {row.path} [locked]" in lines


def test_table_wraps_all_paths_consistently(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "60")
    rows = [
        output.Row("long-project-name", "long-branch", "/wt/" + "x" * 50, merged="squashed"),
        output.Row("short", "feat", "/wt/short", merged="merged"),
    ]
    file = FakeTerminal()
    output.worktree_table(rows, file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert lines[0].split() == ["NAME", "BRANCH", "MERGED"]
    assert lines[2] == f"  ↳ {rows[0].path}"
    assert lines[3] == ""
    assert lines[5] == f"  ↳ {rows[1].path}"
    for row, line_index in zip(rows, (1, 4), strict=True):
        assert lines[0].index("BRANCH") == lines[line_index].index(row.branch)
        assert lines[0].index("MERGED") == lines[line_index].index(row.merged)
    assert all(len(line) <= 60 for line in lines)


def test_table_wraps_long_columns_for_every_row(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "40")
    rows = [
        output.Row("long-project-name", "long-branch-" * 4, "/wt/" + "x" * 50, merged="squashed"),
        output.Row("short", "feat", "/wt/short", merged="merged"),
    ]
    file = FakeTerminal()
    output.worktree_table(rows, file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert lines[0].split() == ["NAME", "MERGED"]
    assert lines[2] == f"  ⑂ {rows[0].branch}"
    assert lines[3] == f"  ↳ {rows[0].path}"
    assert lines[4] == ""
    assert lines[6] == f"  ⑂ {rows[1].branch}"
    assert lines[7] == f"  ↳ {rows[1].path}"
    for row, line_index in zip(rows, (1, 5), strict=True):
        assert lines[0].index("MERGED") == lines[line_index].index(row.merged)


def test_table_wraps_all_metadata_consistently(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "24")
    rows = [
        output.Row("project-name-abc12345", "feature", "/wt/long", merged="squashed"),
        output.Row("short", "feat", "/wt/short", merged="no"),
    ]
    file = FakeTerminal()
    output.worktree_table(rows, file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert lines == [
        "NAME",
        rows[0].name,
        "  ⑂ feature",
        "  ◇ squashed",
        "  ↳ /wt/long",
        "",
        rows[1].name,
        "  ⑂ feat",
        "  ◇ no",
        "  ↳ /wt/short",
    ]


def test_table_measures_terminal_cells(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "26")
    row = output.Row("界" * 8, "branch", "/wt/feature", merged="merged")
    file = FakeTerminal()
    output.worktree_table([row], file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert lines[1] == f"{row.name}  {row.branch}"
    assert lines[2] == "  ◇ merged"
    assert lines[3] == f"  ↳ {row.path}"
    # Each wide character takes two terminal cells, not one.
    assert lines[0].index("BRANCH") == 18


def test_piped_table_does_not_wrap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COLUMNS", "24")
    row = output.Row("x" * 100, "y" * 100, "/" + "z" * 100, merged="no")
    file = io.StringIO()
    output.worktree_table([row], file=file)
    assert file.getvalue() == f"{row.name}  {row.branch}  no  {row.path}\n"


@pytest.mark.parametrize(
    ("path", "expected"),
    [("/home/me", "~"), ("/home/me/wt/x", "~/wt/x"), ("/home/meg/wt/x", "/home/meg/wt/x")],
)
def test_display_path(path: str, expected: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", "/home/me")
    assert output.display_path(path) == expected
