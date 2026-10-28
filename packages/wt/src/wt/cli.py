"""Command-line interface for wt."""

import argparse
import os
import sys
from collections.abc import Callable

from wt import output, shell
from wt.output import done, esc
from wt.repo import (
    Worktree,
    WtError,
    branch_merge_status,
    default_branch,
    find_managed,
    git,
    git_visible,
    list_worktrees,
    local_branch_exists,
    managed_worktrees,
    new_worktree_path,
    project_name,
    remote_branch_exists,
    same_path,
    wt_root,
)

HELP = """\
wt - manage git worktrees in one shared directory

Worktrees live in $XDG_DATA_HOME/wt (default: ~/.local/share/wt). Set WT_ROOT
to use another directory. Each worktree is named <project>-<branch>:
<project> is the main worktree's directory name, <branch> is the branch name
with runs of other characters than letters, digits, '.' and '_' replaced by
'-'. A random six-character suffix is added only if the name is taken by a
filesystem entry or a registered worktree. Run wt inside a git repository.

Usage: wt <command> [options] [arguments]

Create and remove:
  add [-b [--base <ref>]] <branch>
      Create a worktree and print its path.
      <branch>      Branch to check out: a local branch, or a branch that
                    exists on one remote (a local tracking branch is created).
      -b            Create <branch> as a new branch, starting at the current
                    HEAD.
      --base <ref>  With -b: start the new branch at <ref> instead of HEAD.

  remove [-f] [-D] [<name> | --merged]
      Remove worktree <name>. Without <name>, remove the worktree you are in.
      <name>               Worktree to remove.
      --merged             Remove every worktree that ls shows as merged or
                           squashed, except one on the default branch. A branch
                           with no new commits counts as merged.
      -f, --force          Remove even if it has local changes.
      -D, --delete-branch  Also delete its branch. The branch must be merged,
                           unless -f or --merged is given.

  prune
      Drop records of worktrees whose directories are gone. Print directories
      in the wt root that belong to this project but that git no longer
      tracks; delete them yourself if you don't need them.

Find and switch:
  ls
      List this project's worktrees: name, branch, merged status and path.
      MERGED is merged/squashed/no against the default branch, or - if unknown.
      Paths under your home directory use ~. Stale entries (directory gone)
      are marked [prunable].

  dir [<name>]
      Print the path of worktree <name>. Without <name>, print the path of
      the main worktree.

  cd [<name>]
      Change to worktree <name>. Without <name>, change to the main
      worktree. Needs shell integration (see init).

Shell setup:
  init <zsh|bash|fish>
      Print shell integration: completion plus a wt function that changes
      directory after `wt add` and `wt cd`, and moves to the main worktree
      after `wt remove` deletes the current directory. Add to your shell rc:
        eval "$(wt init zsh)"     # ~/.zshrc
        eval "$(wt init bash)"    # ~/.bashrc
        wt init fish | source     # ~/.config/fish/config.fish

  completion <zsh|bash|fish>
      Print the completion script only.

Other:
  help, -h, --help
      Print this help.
"""

SHELLS = ["zsh", "bash", "fish"]


class Parser(argparse.ArgumentParser):
    """ArgumentParser that reports errors in wt's format."""

    def error(self, message: str) -> None:  # type: ignore[override]
        output.error(message)
        output.note("Run [bold]wt help[/] for usage.")
        raise SystemExit(2)


def build_parser() -> Parser:
    parser = Parser(prog="wt", add_help=False)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=Parser)

    def add_command(name: str, handler: Callable[[argparse.Namespace], None]) -> Parser:
        command = commands.add_parser(name, add_help=False)
        command.set_defaults(handler=handler)
        return command

    add = add_command("add", cmd_add)
    add.add_argument("-b", dest="new_branch", action="store_true")
    add.add_argument("--base")
    add.add_argument("branch")

    add_command("ls", cmd_ls)
    add_command("dir", cmd_dir).add_argument("name", nargs="?")
    add_command("cd", cmd_cd).add_argument("name", nargs="?")

    remove = add_command("remove", cmd_remove)
    remove.add_argument("-f", "--force", action="store_true")
    remove.add_argument("-D", "--delete-branch", action="store_true")
    remove.add_argument("--merged", action="store_true")
    remove.add_argument("name", nargs="?")

    add_command("prune", cmd_prune)
    add_command("init", cmd_init).add_argument("shell", choices=SHELLS)
    add_command("completion", cmd_completion).add_argument("shell", choices=SHELLS)

    # Hidden commands used by completion and shell integration.
    add_command("__names", cmd_names)
    add_command("__branches", cmd_branches)
    add_command("__refs", cmd_refs)
    return parser


def cmd_add(args: argparse.Namespace) -> None:
    if args.base and not args.new_branch:
        raise WtError("--base needs -b")
    if not args.new_branch and not (
        local_branch_exists(args.branch) or remote_branch_exists(args.branch)
    ):
        raise WtError(f"branch '{args.branch}' does not exist (use -b to create it)")

    worktrees = list_worktrees()
    path = new_worktree_path(project_name(worktrees[0]), args.branch, worktrees)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Run in the current directory, so HEAD is the HEAD of the worktree we're in.
    if args.new_branch:
        base = args.base or "HEAD"
        git_visible("worktree", "add", "--quiet", "-b", args.branch, str(path), base)
        done(f"Created [bold]{esc(path.name)}[/] on new branch [cyan]{esc(args.branch)}[/]")
    else:
        git_visible("worktree", "add", "--quiet", str(path), args.branch)
        done(f"Created [bold]{esc(path.name)}[/] on branch [cyan]{esc(args.branch)}[/]")
    print(path)


def cmd_ls(args: argparse.Namespace) -> None:
    worktrees = managed_worktrees(list_worktrees())
    if not worktrees:
        return
    statuses = branch_merge_status([w.branch for w in worktrees if w.branch])
    rows = []
    for worktree in worktrees:
        row = output.Row(
            worktree.name,
            worktree.branch or "",
            worktree.path,
            merged=statuses.get(worktree.branch or "", "-"),
        )
        if not worktree.branch:
            row.branch = "(bare)" if worktree.bare else "(detached)"
            row.no_branch = True
        if worktree.prunable:
            row.tags.append("prunable")
        if worktree.locked:
            row.tags.append("locked")
        rows.append(row)
    output.worktree_table(rows)


def cmd_dir(args: argparse.Namespace) -> None:
    print(find_managed(args.name).path if args.name else list_worktrees()[0].path)


def cmd_cd(args: argparse.Namespace) -> None:
    raise WtError(
        "`wt cd` needs shell integration; add this to your shell rc:\n"
        '  eval "$(wt init zsh)"   # zsh; use bash for bash\n'
        "  wt init fish | source   # fish\n"
        'Without it, use: cd "$(wt dir [<name>])"'
    )


def current_managed_worktree(worktrees: list[Worktree]) -> Worktree:
    top = git("rev-parse", "--show-toplevel").strip()
    for worktree in managed_worktrees(worktrees):
        if same_path(worktree.path, top):
            return worktree
    raise WtError("not inside a wt worktree; pass a worktree name")


def remove_worktree(target: Worktree, main: str, force: bool, check: bool = True) -> bool:
    """Remove target, running git from the main worktree so this works from inside target too."""
    if not os.path.isdir(target.path):
        output.warn(f"{target.path} is already gone; pruning its record")
        git_visible("-C", main, "worktree", "prune")
    else:
        force_args = ["--force"] if force else []
        if not git_visible("-C", main, "worktree", "remove", *force_args, target.path, check=check):
            return False
    done(f"Removed [bold]{esc(target.name)}[/]")
    return True


def delete_branch(branch: str, main: str, force: bool, check: bool = True) -> bool:
    delete = "-D" if force else "-d"
    if not git_visible("-C", main, "branch", "--quiet", delete, branch, check=check):
        return False
    done(f"Deleted branch [cyan]{esc(branch)}[/]")
    return True


def cmd_remove(args: argparse.Namespace) -> None:
    if args.merged:
        if args.name:
            raise WtError("--merged takes no <name>")
        remove_merged(args)
        return

    worktrees = list_worktrees()
    main = worktrees[0].path
    target = find_managed(args.name) if args.name else current_managed_worktree(worktrees)
    remove_worktree(target, main, args.force)
    if args.delete_branch:
        if target.branch is None:
            output.warn("worktree had no branch; nothing to delete")
        else:
            delete_branch(target.branch, main, args.force)


def remove_merged(args: argparse.Namespace) -> None:
    """Remove worktrees whose branches `wt ls` shows as merged or squashed.

    Keep going after a failure, and report all failures at the end.
    """
    worktrees = list_worktrees()
    main = worktrees[0].path
    default = default_branch()
    if default is None:
        raise WtError("could not find the default branch, so nothing counts as merged")
    # Never remove a worktree on the default branch itself: it is always "merged".
    candidates = [
        (w, w.branch)
        for w in managed_worktrees(worktrees)
        if w.branch and f"refs/heads/{w.branch}" != default
    ]
    statuses = branch_merge_status([branch for _, branch in candidates])
    merged = [(w, b) for w, b in candidates if statuses[b] in ("merged", "squashed")]
    if not merged:
        output.note("[dim]No merged worktrees[/]")
        return

    failed = []
    for worktree, branch in merged:
        if not remove_worktree(worktree, main, args.force, check=False):
            failed.append(worktree.name)
        # git branch -d would refuse squashed branches, and the check above already passed.
        elif args.delete_branch and not delete_branch(branch, main, True, check=False):
            failed.append(f"branch {branch}")
    if failed:
        raise WtError(f"could not remove: {', '.join(failed)}")


def leftover_dirs(worktrees: list[Worktree]) -> list[str]:
    """Return directories in the wt root that point to this repository but git doesn't track."""
    root = wt_root()
    if not root.is_dir():
        return []
    common_dir = os.path.realpath(
        git("rev-parse", "--path-format=absolute", "--git-common-dir").strip()
    )
    admin_prefix = os.path.join(common_dir, "worktrees") + os.sep
    tracked = {os.path.realpath(w.path) for w in worktrees}
    leftovers = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or os.path.realpath(entry) in tracked:
            continue
        git_file = entry / ".git"
        if not git_file.is_file():
            continue
        content = git_file.read_text(errors="replace").strip()
        if not content.startswith("gitdir:"):
            continue
        gitdir = content.removeprefix("gitdir:").strip()
        if os.path.realpath(os.path.join(entry, gitdir)).startswith(admin_prefix):
            leftovers.append(str(entry))
    return leftovers


def cmd_prune(args: argparse.Namespace) -> None:
    worktrees = list_worktrees()
    git_visible("-C", worktrees[0].path, "worktree", "prune")
    remaining = {w.path for w in list_worktrees()}
    pruned = [w for w in worktrees if w.path not in remaining]
    for worktree in pruned:
        done(f"Pruned [bold]{esc(worktree.name)}[/] [dim](directory was gone)[/]")

    leftovers = leftover_dirs(list_worktrees())
    if leftovers:
        output.warn(
            "these directories belong to this project, but git no longer tracks them;"
            " delete them yourself if you don't need them:"
        )
        for path in leftovers:
            print(path)
    elif not pruned:
        output.note("[dim]Nothing to prune[/]")


def cmd_init(args: argparse.Namespace) -> None:
    print(shell.init_script(args.shell), end="")


def cmd_completion(args: argparse.Namespace) -> None:
    print(shell.completion_script(args.shell), end="")


def cmd_names(args: argparse.Namespace) -> None:
    for worktree in managed_worktrees(list_worktrees()):
        print(worktree.name)


def cmd_branches(args: argparse.Namespace) -> None:
    """Print local branches and remote branches without the remote prefix."""
    local = git("for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads").split()
    remote = git("for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes").split()
    for branch in sorted(set(local) | {b for b in remote if b != "HEAD"}):
        print(branch)


def cmd_refs(args: argparse.Namespace) -> None:
    output = git(
        "for-each-ref",
        "--format=%(refname) %(refname:short)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    )
    for line in output.splitlines():
        full, _, short = line.partition(" ")
        if not (full.startswith("refs/remotes/") and full.endswith("/HEAD")):
            print(short)


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        output.print_help(HELP, file=sys.stderr)
        raise SystemExit(2)
    if argv[0] == "help" or "-h" in argv or "--help" in argv:
        output.print_help(HELP)
        return

    args = build_parser().parse_args(argv)
    try:
        args.handler(args)
    except WtError as error:
        output.error(str(error))
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None
