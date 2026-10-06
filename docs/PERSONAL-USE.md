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
   [Node.js 22 LTS](https://nodejs.org/) (the installer that matches your PC: **ARM64** on a
   Windows on Arm machine). If `npm ci` later complains about building `better-sqlite3`, also
   install the Visual Studio Build Tools with the "Desktop development with C++" workload.
2. Clone into a normal Windows folder, separate from your WSL clone (building from
   `\\wsl.localhost\...` is slow and breaks native modules):
   ```
   cd $HOME\coding
   git clone https://github.com/Matthewweb42/Mythscribe.git mythscribe-app
   ```

## Install or update

Push what you want to use to `main` first (from WSL, as usual). Close MythScribe, then in
PowerShell:

```
cd $HOME\coding\mythscribe-app
powershell -ExecutionPolicy Bypass -File scripts\install-personal.ps1
```

The script pulls `main`, builds it (it stops if the typecheck fails), builds the installer in
`dist\`, and runs it. Windows SmartScreen warns about an unknown publisher because the build is
unsigned: choose **More info → Run anyway**. Reinstalling over the old version keeps your
projects, settings, AI key, and backups; they are not in the install folder.

Run the gates in WSL before pushing something you mean to write with: `npm run test` at least,
and `npm run test:e2e` for anything that touches saving.

## First run in the installed app

1. **Create your book** with the new-project wizard. The default folder is
   `Documents\MythScribe`. Keep it out of OneDrive/Dropbox while the app has it open; sync tools
   and an open database do not mix.
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

## If something goes wrong

- **The app will not open a book:** read the message. "Newer version" means reinstall from the
  latest `main`. Anything else: restore a backup from Settings › Backups; it opens as a copy
  named `… (restored <date>).mythscribe` beside the original, which stays untouched for
  debugging.
- **A build of `main` is broken:** the old installed version keeps working until the script
  succeeds; it only installs after a clean build. To pin a known-good version, check out a
  commit in the Windows clone and run the steps from `npm ci` onward by hand.
