"""Shell completion and integration scripts."""

ZSH_COMPLETION = r"""#compdef wt

_wt_names() {
  local -a names
  names=(${(f)"$(command wt __names 2>/dev/null)"})
  _wanted worktrees expl 'worktree' compadd -a names
}

_wt_branches() {
  local -a branches
  branches=(${(f)"$(command wt __branches 2>/dev/null)"})
  _wanted branches expl 'branch' compadd -a branches
}

_wt_refs() {
  local -a refs
  refs=(${(f)"$(command wt __refs 2>/dev/null)"})
  _wanted refs expl 'ref' compadd -a refs
}

_wt() {
  local curcontext="$curcontext" state line
  typeset -A opt_args
  local -a help_opts
  help_opts=('(- *)'{-h,--help}'[show help]')

  _arguments -C $help_opts '1: :->command' '*:: :->args' && return

  case $state in
    command)
      local -a commands
      commands=(
        'add:create a worktree and print its path'
        'ls:list worktrees of this project'
        'dir:print the path of a worktree'
        'cd:change to a worktree (needs shell integration)'
        'remove:remove a worktree'
        'prune:clean up stale worktree records'
        'init:print shell integration'
        'completion:print the completion script'
        'help:show help'
      )
      _describe -t commands 'wt command' commands
      ;;
    args)
      curcontext="${curcontext%:*:*}:wt-$words[1]:"
      case $words[1] in
        add)
          _arguments -C $help_opts \
            '-b[create a new branch]' \
            '--base=[start the new branch at this ref]:ref:_wt_refs' \
            '1: :->branch' && return
          if [[ $state == branch ]]; then
            if (( ${+opt_args[-b]} )); then
              _message 'new branch name'
            else
              _wt_branches
            fi
          fi
          ;;
        dir|cd)
          _arguments $help_opts '::worktree:_wt_names'
          ;;
        remove)
          _arguments $help_opts \
            '(-f --force)'{-f,--force}'[remove even with local changes]' \
            '(-D --delete-branch)'{-D,--delete-branch}'[also delete the branch]' \
            '(1)--merged[remove all merged worktrees]' \
            '(--merged)1:worktree:_wt_names'
          ;;
        init|completion)
          _arguments $help_opts '1:shell:(zsh bash fish)'
          ;;
        *)
          _arguments $help_opts
          ;;
      esac
      ;;
  esac
}

if [ "$funcstack[1]" = "_wt" ]; then
  _wt "$@"
else
  compdef _wt wt
fi
"""

BASH_COMPLETION = r"""# Add the lines of `wt $1` that start with $2 to COMPREPLY. Do not use
# `compgen -W` here: it expands $(...) and backticks, which git allows in
# branch and tag names.
_wt_lines() {
  local line
  while IFS= read -r line; do
    [[ "$line" == "$2"* ]] && COMPREPLY+=("$line")
  done < <(command wt "$1" 2>/dev/null)
}

_wt() {
  local cur prev cmd word new_branch=0 i
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()

  if (( COMP_CWORD == 1 )); then
    COMPREPLY=($(compgen -W "add ls dir cd remove prune init completion help -h --help" -- "$cur"))
    return
  fi

  cmd="${COMP_WORDS[1]}"
  case "$cmd" in
    add)
      if [[ "$prev" == --base ]]; then
        _wt_lines __refs "$cur"
        return
      fi
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-b --base -h --help" -- "$cur"))
        return
      fi
      for (( i = 2; i < COMP_CWORD; i++ )); do
        word="${COMP_WORDS[i]}"
        [[ "$word" == -b ]] && new_branch=1
      done
      if (( new_branch == 0 )); then
        _wt_lines __branches "$cur"
      fi
      ;;
    dir|cd)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-h --help" -- "$cur"))
      else
        _wt_lines __names "$cur"
      fi
      ;;
    remove)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-f --force -D --delete-branch --merged -h --help" -- "$cur"))
      else
        _wt_lines __names "$cur"
      fi
      ;;
    init|completion)
      if (( COMP_CWORD == 2 )); then
        COMPREPLY=($(compgen -W "zsh bash fish" -- "$cur"))
      fi
      ;;
    *)
      COMPREPLY=($(compgen -W "-h --help" -- "$cur"))
      ;;
  esac
}

complete -F _wt wt
"""

FISH_COMPLETION = r"""complete -c wt -f
complete -c wt -s h -l help -d 'Show help'

complete -c wt -n __fish_use_subcommand -a add -d 'Create a worktree and print its path'
complete -c wt -n __fish_use_subcommand -a ls -d 'List worktrees of this project'
complete -c wt -n __fish_use_subcommand -a dir -d 'Print the path of a worktree'
complete -c wt -n __fish_use_subcommand -a cd -d 'Change to a worktree (needs shell integration)'
complete -c wt -n __fish_use_subcommand -a remove -d 'Remove a worktree'
complete -c wt -n __fish_use_subcommand -a prune -d 'Clean up stale worktree records'
complete -c wt -n __fish_use_subcommand -a init -d 'Print shell integration'
complete -c wt -n __fish_use_subcommand -a completion -d 'Print the completion script'
complete -c wt -n __fish_use_subcommand -a help -d 'Show help'

complete -c wt -n '__fish_seen_subcommand_from add' -s b -d 'Create a new branch'
complete -c wt -n '__fish_seen_subcommand_from add' -l base -x \
    -a '(command wt __refs 2>/dev/null)' -d 'Start the new branch at this ref'
complete -c wt -n '__fish_seen_subcommand_from add; and not __fish_contains_opt -s b' \
    -a '(command wt __branches 2>/dev/null)'

complete -c wt -n '__fish_seen_subcommand_from dir cd remove' -a '(command wt __names 2>/dev/null)'
complete -c wt -n '__fish_seen_subcommand_from remove' -s f -l force \
    -d 'Remove even with local changes'
complete -c wt -n '__fish_seen_subcommand_from remove' -s D -l delete-branch \
    -d 'Also delete the branch'
complete -c wt -n '__fish_seen_subcommand_from remove' -l merged \
    -d 'Remove all merged worktrees'

complete -c wt -n '__fish_seen_subcommand_from init completion' -a 'zsh bash fish'
"""

# Shared by zsh and bash. A child process cannot change the shell's directory,
# so this function runs `cd` with the path that wt prints.
SHELL_FUNCTION = r"""wt() {
  local _wt_out _wt_main _wt_status
  case "$1" in
    add|cd)
      if [ "$1" = cd ]; then
        shift
        set -- dir "$@"
      fi
      _wt_out="$(command wt "$@")" || return
      if [ -d "$_wt_out" ]; then
        cd -- "$_wt_out"
      elif [ -n "$_wt_out" ]; then
        printf '%s\n' "$_wt_out"
      fi
      ;;
    remove)
      _wt_main="$(command wt dir 2>/dev/null)"
      command wt "$@"
      _wt_status=$?
      # Even if wt failed, it may have removed the current directory.
      if [ ! -d "$PWD" ] && [ -n "$_wt_main" ]; then
        cd -- "$_wt_main"
      fi
      return "$_wt_status"
      ;;
    *)
      command wt "$@"
      ;;
  esac
}
"""

# Same as SHELL_FUNCTION, in fish syntax.
FISH_FUNCTION = r"""function wt --description 'Manage git worktrees'
    switch "$argv[1]"
        case add cd
            set -l args $argv
            if test "$argv[1]" = cd
                set args dir $argv[2..-1]
            end
            set -l out (command wt $args); or return
            if test -d "$out"
                cd $out
            else if test -n "$out"
                printf '%s\n' $out
            end
        case remove
            set -l main (command wt dir 2>/dev/null)
            command wt $argv
            set -l wt_status $status
            if not test -d "$PWD"; and test -n "$main"
                cd $main
            end
            return $wt_status
        case '*'
            command wt $argv
    end
end
"""

COMPLETIONS = {"zsh": ZSH_COMPLETION, "bash": BASH_COMPLETION, "fish": FISH_COMPLETION}
FUNCTIONS = {"zsh": SHELL_FUNCTION, "bash": SHELL_FUNCTION, "fish": FISH_FUNCTION}


def completion_script(shell: str) -> str:
    return COMPLETIONS[shell]


def init_script(shell: str) -> str:
    return FUNCTIONS[shell] + "\n" + COMPLETIONS[shell]
