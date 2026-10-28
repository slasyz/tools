import io
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from wt import output
from wt.cli import HELP
from wt.repo import sanitize

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
    assert re.fullmatch(r"myproj-feature-some-feature-[a-z0-9]{6}", path.name)
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
    assert second.name.startswith("myproj-second-")


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
    assert lines[0].split() == [path.name, "feat", str(path)]

    assert env.wt("__names", cwd=repo).stdout.split() == [path.name]
    assert env.wt("dir", path.name, cwd=repo).stdout.strip() == str(path)

    result = env.wt("dir", "unknown", cwd=repo, ok=False)
    assert result.returncode == 1
    assert "no worktree named" in result.stderr


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
    for flag in ["-b", "--base", "--force", "--delete-branch"]:
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
    assert "--delete-branch" in complete("wt", "remove", "--")
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
    assert "--delete-branch" in complete("wt remove --")
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


def test_table_in_terminal(color_env: None) -> None:
    rows = [
        output.Row("proj-feat-abc123", "feat", "/wt/proj-feat-abc123"),
        output.Row("proj-x-def456", "(detached)", "/wt/proj-x-def456", True, ["prunable"]),
    ]
    file = FakeTerminal()
    output.worktree_table(rows, file=file)
    lines = ANSI.sub("", file.getvalue()).splitlines()
    assert "\x1b[" in file.getvalue()
    assert lines[0].split() == ["NAME", "BRANCH", "PATH"]
    assert lines[2].split() == ["proj-x-def456", "(detached)", "/wt/proj-x-def456", "[prunable]"]


def test_table_when_piped() -> None:
    rows = [output.Row("proj-x-def456", "(detached)", "/wt/x", True, ["prunable", "locked"])]
    file = io.StringIO()
    output.worktree_table(rows, file=file)
    assert file.getvalue() == "proj-x-def456  (detached)  /wt/x [prunable] [locked]\n"
