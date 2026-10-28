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
from pathlib import Path
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from rich.console import Console

    from wt.repo import MergeStatus


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
    merged: "MergeStatus" = "-"


def display_path(path: str) -> str:
    """Abbreviate only paths inside the current user's home directory."""
    try:
        return str(Path("~") / Path(path).relative_to(Path.home()))
    except ValueError:
        return path


def worktree_table(rows: list[Row], file: TextIO | None = None) -> None:
    file = file or sys.stdout
    if not file.isatty():
        table = []
        for row in rows:
            path = " ".join([display_path(row.path), *(f"[{tag}]" for tag in row.tags)])
            table.append([row.name, row.branch, row.merged, path])
        widths = [max(len(cell) for cell in column) for column in zip(*table, strict=True)]
        for *cells, path in table:
            padded = [cell.ljust(width) for cell, width in zip(cells, widths, strict=False)]
            print(*padded, path, sep="  ", file=file)
        return

    from rich.console import Console
    from rich.text import Text

    console = Console(file=file, soft_wrap=True)
    headers = [Text(label, style="bold dim") for label in ("NAME", "BRANCH", "MERGED", "PATH")]
    cells = [headers]
    for row in rows:
        branch = Text(row.branch, style="italic magenta" if row.no_branch else "cyan")
        path = Text(display_path(row.path))
        for tag in row.tags:
            path.append(f" [{tag}]", style="yellow")
        merged = Text(row.merged, style="green" if row.merged in ("merged", "squashed") else "dim")
        cells.append([Text(row.name, style="bold"), branch, merged, path])

    widths = [max(cell.cell_len for cell in column) for column in zip(*cells, strict=True)]
    # Columns that don't fit move below each row. NAME always stays, even if it alone is too wide.
    inline, wrapped = [0], []
    used_width = widths[0]
    for index in range(1, len(widths)):
        if used_width + 2 + widths[index] <= console.width:
            inline.append(index)
            used_width += 2 + widths[index]
        else:
            wrapped.append(index)
    markers = ("", "⑂", "◇", "↳")
    for row_index, row_cells in enumerate(cells):
        if wrapped and row_index > 1:
            console.print()
        line = Text()
        for index in inline[:-1]:
            cell = row_cells[index]
            line.append(cell).append(" " * (widths[index] - cell.cell_len + 2))
        line.append(row_cells[inline[-1]])
        console.print(line)
        if row_index > 0:
            for index in wrapped:
                console.print(Text.assemble((f"  {markers[index]} ", "dim"), row_cells[index]))


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
