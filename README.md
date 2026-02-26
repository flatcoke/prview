# prview

Git diff viewer in your browser. Self-review before you push.

Built for [worktree](https://git-scm.com/docs/git-worktree)-heavy workflows where your editor can't show a clean diff across branches.

https://github.com/user-attachments/assets/a611016b-4be2-4a3d-84bc-cf17797a9a4c

## Install

```bash
brew install flatcoke/tap/prview
```

## Usage

```bash
prview                    # current repo
prview ~/src              # all repos under a directory
prview main..feature      # branch comparison
prview HEAD~3             # last 3 commits
prview --staged           # staged only
prview --all              # staged + unstaged
prview --port 9999        # custom port (default: 8888)
prview --no-open          # skip browser open
```

## Features

- Split / unified diff toggle
- Three modes — all, branch-only, uncommitted
- Git worktree support with grouped dropdown
- Live reload over WebSocket
- Multi-repo workspace discovery
- Bookmarkable URLs

## License

MIT
