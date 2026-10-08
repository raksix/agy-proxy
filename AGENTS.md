# Project Guidelines & Autonomous Agent Rules

## Git Commit & Push Policy
- **Automatic Commits & Pushes**: Whenever any change or modification is made to this codebase or repository, immediately commit with an atomic, descriptive English commit message and push (`git push origin main`) to the remote repository. Never leave changes uncommitted or unpushed.
- **Commit Style**: Use Conventional Commits format in English (e.g., `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`).

## Memory Integration
- The user's external memory vault is located at `https://memory.fermag.com.tr/`.
- Check memory on every request and align actions with memory guidelines.
- Always save key decisions, findings, workflows, and user directives into the memory vault via `/root/memory-vault/bin/vault.py`.
