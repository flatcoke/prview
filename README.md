# prview

GitHub-style git diff viewer in your browser.

## Install

```bash
brew install flatcoke/prview/prview
```

Or build from source:

```bash
make build
```

## Usage

```bash
prview                    # unstaged changes
prview --staged           # staged changes
prview --all              # staged + unstaged
prview HEAD~3             # changes since 3 commits ago
prview main..feature      # branch comparison
prview --port 9999        # custom port
prview --no-open          # don't auto-open browser
```

## License

MIT
