"""Terminal output.

Messages go to stderr through rich, which drops colors when stderr is not a terminal.
Tables and help use rich only when stdout is a terminal, so piped output stays plain
and easy to parse. rich is imported on first use, so `wt dir` and the completion
helpers don't pay for it.
"""

import re
import sys
from dataclasses import dataclass, field
from functools import cache
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from rich.console import Console


@cache
def _stderr() -> "Console":
    from rich.console import Console

    return Console(stderr=True, highlight=False, soft_wrap=True)


def esc(text: str) -> str:
    """Escape text for use inside rich markup."""
    from rich.markup import escape

    return escape(text)


def error(message: str) -> None:
    _stderr().print(f"[bold red]wt:[/] {esc(message)}")


def warn(message: str) -> None:
    _stderr().print(f"[bold yellow]wt:[/] {esc(message)}")


def note(markup: str) -> None:
    _stderr().print(markup)


def done(markup: str) -> None:
    """Report success. Escape values in `markup` with esc()."""
    _stderr().print(f"[green]✓[/] {markup}")


@dataclass
class Row:
    name: str
    branch: str
    path: str
    # True if branch is a placeholder such as "(detached)".
    no_branch: bool = False
    tags: list[str] = field(default_factory=list)


def worktree_table(rows: list[Row], file: TextIO | None = None) -> None:
    file = file or sys.stdout
    if not file.isatty():
        name_width = max((len(row.name) for row in rows), default=0)
        branch_width = max((len(row.branch) for row in rows), default=0)
        for row in rows:
            path = " ".join([row.path, *(f"[{tag}]" for tag in row.tags)])
            print(f"{row.name:<{name_width}}  {row.branch:<{branch_width}}  {path}", file=file)
        return

    from rich.console import Console
    from rich.table import Table
    from rich.text import Text

    table = Table(box=None, pad_edge=False, header_style="bold dim")
    table.add_column("NAME", style="bold", no_wrap=True)
    table.add_column("BRANCH", style="cyan", no_wrap=True)
    table.add_column("PATH", overflow="fold")
    for row in rows:
        branch = Text(row.branch, style="italic magenta" if row.no_branch else "")
        path = Text(row.path)
        for tag in row.tags:
            path.append(f" [{tag}]", style="yellow")
        table.add_row(row.name, branch, path)
    Console(file=file).print(table)


HELP_STYLES = [
    (re.compile(r"\A.*$", re.M), "bold"),
    (re.compile(r"^[A-Z][\w ]*:", re.M), "bold"),
    (re.compile(r"^  [a-z]+", re.M), "bold cyan"),
    (re.compile(r"(?<![\w-])--?[A-Za-z][\w-]*"), "yellow"),
    (re.compile(r"<[\w|]+>"), "green"),
    (re.compile(r"#.*$", re.M), "dim"),
]


def print_help(text: str, file: TextIO | None = None) -> None:
    file = file or sys.stdout
    if not file.isatty():
        print(text, end="", file=file)
        return

    from rich.console import Console
    from rich.text import Text

    styled = Text(text)
    for pattern, style in HELP_STYLES:
        styled.highlight_regex(pattern, style)
    Console(file=file, highlight=False, soft_wrap=True).print(styled, end="")
