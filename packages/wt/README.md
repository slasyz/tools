# wt

Manage git worktrees in one shared directory: `~/.local/share/wt` (or `$XDG_DATA_HOME/wt`; set `WT_ROOT` to change it).

New worktrees are named `<project>-<branch>`, for example `tools-feature-login`.
`<project>` is the main worktree's directory name; branch names are made safe for
directory names. A random six-character suffix, such as `-k3x9q2`, is added only
if the name is taken by a filesystem entry or a registered worktree (including
stale records). Existing worktrees keep their names. Git branch names do not change.

## Commands

Run inside a git repository.

```sh
# Create and remove
wt add -b feature/login          # new branch from current HEAD, print worktree path
wt add -b hotfix --base v1.2.0   # new branch from a given ref
wt add feature/login             # existing local or remote branch
wt remove <name>                 # remove worktree, keep branch
wt remove                        # remove the worktree you are in
wt remove -f -D <name>           # remove even if dirty, delete branch even if unmerged
wt remove --merged               # remove all worktrees that `wt ls` shows as merged or squashed
wt remove --merged -D            # same, and delete their branches
wt prune                         # clean records of deleted worktrees, list leftovers

# Find and switch
wt ls                            # list this project's worktrees
wt dir <name>                    # print worktree path
wt dir                           # print main worktree path
wt cd <name>                     # go to worktree (needs shell integration)
wt cd                            # go to main worktree (needs shell integration)

# Shell setup
wt init zsh                      # print shell integration (also: bash, fish)
wt completion zsh                # print completion script only (also: bash, fish)

wt help                          # full help (also: -h, --help)
```

Output is colored in a terminal and plain when piped. Set `NO_COLOR=1` to turn colors off.

`wt ls` shows `MERGED` as:

- `merged`: the branch's tip is an ancestor of the default branch.
- `squashed`: the branch's combined patch matches a commit in default-branch history.
- `no`: neither check found a match.
- `-`: a detached worktree or an unknown default branch.

Squash detection compares stable Git patch IDs (which ignore whitespace) against
up to 500 recent non-merge commits since the branch's merge base. Patch IDs are
reused across listed branches during each command, with no disk cache. Older
squashes, conflict-resolution changes, and multi-commit rebase merges may still
show `no`. This checks history, not whether later commits reverted the changes.

The default branch comes from `origin/HEAD`, then another remote's HEAD, then
`main` or `master`. The local default branch is used when present; otherwise the
remote-tracking ref is used as last fetched. `wt ls` does not fetch.

`wt remove --merged` uses the same check. It skips a worktree on the default
branch and worktrees with local changes (unless `-f` is given), and keeps going
after a failure. A branch with no new commits counts as merged, so a fresh,
clean worktree is removed too. With `-D`, it deletes branches even if they were
squashed, which `git branch -d` would refuse.

Rows use one layout for the whole list, sized for the widest value in each column.
NAME stays on the first line. Other columns stay aligned with their headers when
they fit; otherwise, the whole column moves below every row: `⑂` for BRANCH,
`◇` for MERGED, and `↳` for PATH. Wrapped entries have a blank line between them.
Values are never split or truncated, so a value wider than the terminal may
overflow. Piped output stays unwrapped.
Paths under your home directory start with `~`; `wt dir` still prints the full path.

Without shell integration, use `cd "$(wt add -b feature/login)"` or `cd "$(wt dir <name>)"` (`cd "$(wt dir)"` for the main worktree).


## Install

Requires Python 3.12+, uv and git.

```sh
uv tool install --editable .
```

Shell integration (completion, plus `wt cd` and changing directory after `wt add`). Add to `~/.zshrc`:

```zsh
# wt completion
# Must be after shell/plugin init so completion system is ready.
if [[ -o interactive ]] && command -v wt >/dev/null 2>&1; then
  eval "$(wt init zsh)"
fi
```

For bash, add to `~/.bashrc`:

```bash
# wt completion
if [[ $- == *i* ]] && command -v wt >/dev/null 2>&1; then
  eval "$(wt init bash)"
fi
```

For fish, add to `~/.config/fish/config.fish`:

```fish
# wt completion
if status is-interactive; and command -q wt
  wt init fish | source
end
```

## Development

```sh
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
```
