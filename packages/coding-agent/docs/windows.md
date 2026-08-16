# Windows Setup

On Windows, the LLM-callable command tool defaults to PowerShell 7 (`pwsh`); on Linux and macOS it defaults to `bash`. The default built-in tool set is `read`, `pwsh`, `edit`, `write` on Windows. Use `--tools read,bash` to opt into the bash tool instead; explicit `--tools` selections are never rewritten by platform defaults.

Pi resolves the pwsh executable (in order):

1. Custom path from `~/.pi/agent/settings.json` (`pwshPath`)
2. `pwsh` / `pwsh.exe` on PATH
3. `C:\Program Files\PowerShell\7\pwsh.exe`

If PowerShell 7 is not installed, install it from [Microsoft](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) or set `pwshPath` in settings.json. Pi never falls back to Windows PowerShell 5.1 (`powershell.exe`), Git Bash, or `cmd.exe` for the pwsh tool.

## Custom Pwsh Path

```json
{
  "pwshPath": "C:\\tools\\PowerShell\\7\\pwsh.exe"
}
```

## Interactive ! / !!

Interactive `!` / `!!` commands use PowerShell 7 on Windows, matching the platform-default command tool. Pi resolves the pwsh executable the same way as the pwsh tool:

1. Custom path from `~/.pi/agent/settings.json` (`pwshPath`)
2. `pwsh` / `pwsh.exe` on PATH
3. `C:\Program Files\PowerShell\7\pwsh.exe`

If PowerShell 7 is not installed, the command fails with an explicit "No pwsh (PowerShell 7) found" error. Pi never falls back to Windows PowerShell 5.1 (`powershell.exe`), `cmd.exe`, or Git Bash for interactive `!` commands.

## Explicit Bash Tool

The explicit `bash` tool (`--tools read,bash,edit,write`) always executes real Bash on every platform, including Windows. Pi checks these locations (in order):

1. Custom path from `~/.pi/agent/settings.json` (`shellPath`)
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

If Bash is not installed, the bash tool fails with an explicit error; it never falls back to Pwsh or `cmd.exe`. For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
