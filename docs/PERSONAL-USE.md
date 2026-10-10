# Using MythScribe for your own writing

How to run MythScribe as a real installed app on your own Windows PC, keep writing in it every
day, and keep developing it without risking your books. This is not the public release
(`docs/RELEASING.md`); nothing here is signed or published.

## The idea: two copies that never share a book

| | **Installed app** (for writing) | **Dev app** (for building) |
|---|---|---|
| Where it runs | Windows, from the Start menu | WSL, `npm run dev` / `npm run test:e2e` |
| Built from | the latest `main`, when you choose to reinstall | whatever you are working on |
| Settings, AI key, recents | `%APPDATA%\MythScribe` | `~/.config/mythscribe` in WSL |
| Projects | `Documents\MythScribe` (Windows) | throwaway projects in WSL |
| Backups | `Documents\MythScribe Backups` (Windows) | WSL |

Rule: **your real books are only ever opened by the installed app.** Test in dev with throwaway
projects. If dev ever does open a real book, it upgrades the book's database, and the installed
app will then refuse it with "saved by a newer version of MythScribe" until you reinstall from a
`main` that has the same change. Nothing is lost; it just waits for the reinstall.

## One-time setup (Windows)

1. Install [Git for Windows](https://git-scm.com/download/win) and
   [Node.js](https://nodejs.org/) 22.22.2+ or 24.15+ (the installer that matches your PC:
   **ARM64** on a Windows on Arm machine; `winget upgrade OpenJS.NodeJS.LTS` updates it). Install
   the Visual Studio 2022 Build Tools with the "Desktop development with C++" workload, and on
   Windows on Arm also the **MSVC v143 ARM64/ARM64EC build tools** component; without it `npm ci`
   fails building `better-sqlite3` with `MSB8020 ... v143 ... cannot be found`. From an
   Administrator PowerShell:
   ```
   & "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --includeRecommended --passive
   ```
2. Clone into a normal Windows folder, separate from your WSL clone (building from
   `\\wsl.localhost\...` is slow and breaks native modules):
   ```
   cd $HOME\coding
   git clone https://github.com/Matthewweb42/Mythscribe.git mythscribe-app
   ```
3. **Turn on the developer switch**, so your copy never turns read-only (not when the 30-day
   trial ends, not when a license check has been offline too long; F-15.13, decided 2026-10-10).
   In PowerShell:
   ```
   setx MYTHSCRIBE_DEV_LICENSE 1
   ```
   Then sign out of Windows and back in (programs started from the Start menu only see a new
   variable after that). Check it in the installed app: Settings › Account no longer counts trial
   days, and no trial banner appears. The switch is read only at launch, only from this variable,
   and only the exact value `1` counts; nothing in the app's menus or settings can turn it on or
   off. To turn it off: `reg delete HKCU\Environment /v MYTHSCRIBE_DEV_LICENSE /f`, then sign out
   and in. For the dev app in WSL, `export MYTHSCRIBE_DEV_LICENSE=1` before `npm run dev` (leave
   it unset when you want to try the trial yourself). Never set it on a machine you hand to
   someone else, and never in the e2e or a release build script.

## Install or update

Push what you want to use to `main` first (from WSL, as usual). Close MythScribe, then in
PowerShell:

```
cd $HOME\coding\mythscribe-app
powershell -ExecutionPolicy Bypass -File scripts\install-personal.ps1
```

The script pulls `main`, builds it (it stops if the typecheck fails), builds the installer in
`dist\`, and runs it. Windows SmartScreen warns about an unknown publisher because the build is
unsigned: choose **More info → Run anyway**. If the installer leaves out `MythScribe.exe` (seen
once on Windows on Arm: the Start-menu shortcut then asks you to browse for the program), the
script copies the unpacked build into `%LOCALAPPDATA%\Programs\MythScribe` itself. Reinstalling over the old version keeps your
projects, settings, AI key, and backups; they are not in the install folder.

Run the gates in WSL before pushing something you mean to write with: `npm run test` at least,
and `npm run test:e2e` for anything that touches saving.

## First run in the installed app

1. **Create your book** with the new-project wizard. The default folder is
   `Documents\MythScribe`. A project in Google Drive, OneDrive, Dropbox, or iCloud Drive works
   too (since 2026-10-08): MythScribe works on a copy on this PC and copies it back to the
   project folder every few minutes, when you close it, and when you quit. The status bar says
   when it last copied ("Copied to Google Drive 2 min ago"). Close MythScribe before opening the
   project on another computer, and let Drive finish syncing first.
2. **Backups** (Settings › Backups): point the backup folder at a synced folder (OneDrive,
   Dropbox) so a copy leaves the machine. Backups are on by default (every 30 minutes when
   something changed, and on close; the last 10 kept) and are restored from the same tab.
   Tools › Snapshots… and Tools › Drafts… keep versions of the text inside the book.
3. **AI** (optional): Settings › AI, paste your OpenAI API key (stored encrypted by Windows),
   then raise the AI dial; it starts at Off. Cloud sign-in and credits are not needed; your key
   pays OpenAI directly at their prices. The usage meter in Settings shows what each feature
   costs.
4. **Updates** (Settings › Updates): turn off "Check for updates automatically". There are no
   published releases yet, so the check can only report an error. You update by re-running the
   script.

## Bringing in old projects and running AI offline

- **A project from the old prototype (v0):** open it as usual (the single `.mythscribe` file, or
  the `project.db` inside an old project folder). MythScribe asks before converting it; the
  converted project keeps the same name and the untouched original is kept beside it as
  `<Name> (v0 backup <date>).mythscribe`.
- **AI without the internet:** install [Ollama](https://ollama.com), run `ollama pull llama3.1`,
  then in Settings › AI choose **Local model**, set the model names to what you downloaded, and
  press Test connection. Requests cost nothing and stay on your computer; answers are weaker than
  OpenAI's.

## If something goes wrong

- **The app will not open a book:** read the message. "Newer version" means reinstall from the
  latest `main`. Anything else: restore a backup from Settings › Backups; it opens as a copy
  named `… (restored <date>).mythscribe` beside the original, which stays untouched for
  debugging.
- **A build of `main` is broken:** the old installed version keeps working until the script
  succeeds; it only installs after a clean build. To pin a known-good version, check out a
  commit in the Windows clone and run the steps from `npm ci` onward by hand.
