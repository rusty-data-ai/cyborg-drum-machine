# Agent sessions: read this first

Version-control protocol: see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Summary:
trunk is `chris-dev` (commit atomic changes directly to it; push after each green
feature); `main` is production and is never merged/pushed without the owner's
explicit approval.

Environment constraints for agents working in this repo:

- The owner runs a PreToolUse safety hook keyed to the bash shell's CWD: **keep
  your shell CWD at the repo root** at all times; use subshells like
  `(cd web && ...)` for package commands.
- **Never use `rm -rf`** (delete individual files with `rm`/`rmdir`). `pkill` is
  also blocked — stop processes via the harness or `kill <pid>`.
- Datasets in `data/` are gitignored (~600 MB, restored by `ml/download_data.sh`);
  never commit them, model checkpoints, or `node_modules`.
