# Moving GB POS to a new GitHub account

This move does not require moving the Supabase project. The database, Auth users,
Edge Functions, and stored shop data remain in Supabase. GitHub hosts the source,
release files, update feed, APK, and public web build.

Do not delete or overwrite the existing local repository. Do not create a new app
from a ZIP: preserving this Git history keeps every version and release commit.

## 1. Create the destination repository

1. Sign in to the new GitHub account.
2. Create a private repository named `GB-POS` (or choose a different final name).
3. Do not initialize it with a README, license, or `.gitignore`.
4. Enable GitHub Actions and GitHub Pages for the repository.

Record these two values before editing anything:

- New GitHub owner: `<NEW_OWNER>`
- Repository name: `<NEW_REPO>`

The resulting URLs will be:

- Repository: `https://github.com/<NEW_OWNER>/<NEW_REPO>`
- Web app: `https://<NEW_OWNER>.github.io/<NEW_REPO>`

## 2. Preserve Android update compatibility

Android will only install a new APK over the current app when both APKs use the
same application ID and signing certificate. Copy these four Actions secrets from
a secure backup of the existing signing setup. If the old account cannot be
accessed, recover the original keystore and passwords from the machine or backup
used for prior releases before publishing a replacement APK.

- `GBPOS_ANDROID_KEYSTORE_BASE64`
- `GBPOS_ANDROID_KEYSTORE_PASSWORD`
- `GBPOS_ANDROID_KEY_ALIAS`
- `GBPOS_ANDROID_KEY_PASSWORD`

Generating a different keystore would require uninstalling the current Android
app before installing future versions, which is exactly the failure we want to
avoid.

## 3. Configure Actions variables and secrets

In the new repository, open **Settings → Secrets and variables → Actions** and add:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SHOP_LOGIN_EMAIL`
- `VITE_SHOP_LOGIN_USERNAME` (optional; defaults to `Gadgetboyz`)
- `VITE_DURANT_LOGIN_EMAIL` (if the Durant portal is used)
- The four Android signing secrets listed above

The standard `GITHUB_TOKEN` is created automatically by GitHub Actions; do not
copy or create a personal token under that name.

## 4. Update repository-owned URLs

Replace the old owner/repository and Pages URL in these active files:

- `package.json` (`repository.url` controls Electron Builder publishing)
- `app/electron/electron-main.ts` (release and public-app fallbacks)
- `src/mobile/MobileUpdateCheck.tsx` (APK release lookup)
- `src/mobile/mobile-api.ts` (hosted app fallback)
- `src/workorders/releasePrint.ts` and `src/components/InventoryWindow.tsx`
- `.github/workflows/release.yml` and `.github/workflows/pages.yml`
- `supabase/functions/client-updates/index.ts`
- `supabase/functions/client-response/index.ts`
- `docs/WEB-INTERFACE.txt`

Historical changelog and old design-plan links can remain historical. Update the
active files before the first new release so installed desktop and Android apps
look for updates in the new repository.

## 5. Point this local repository at the new account

After authenticating Git on this computer with the new GitHub account, preserve
the old address as a read-only reference and set the new repository as `origin`:

```powershell
git remote rename origin old-origin
git remote add origin https://github.com/<NEW_OWNER>/<NEW_REPO>.git
git remote -v
git push -u origin --all
git push origin --tags
```

If the old remote is no longer useful, it can be removed later with
`git remote remove old-origin`. Removing a remote does not delete local history.

## 6. Update Supabase public URL settings

In Supabase Auth URL Configuration, add the new Pages URL and its callback forms
to the allowed redirect URLs. Keep the old Pages URL temporarily if installed
older versions still use it.

Set the `PUBLIC_APP_URL` Edge Function secret to the new Pages URL, then redeploy
the `client-updates` and `client-response` functions. This keeps email buttons and
public repair-status links on the new web host without exposing the POS.

Apply the pending database migration after linking the Supabase CLI:

```powershell
npx supabase login
npx supabase link --project-ref hpuwxtfwogtsbmdvunan
npx supabase migration list
npx supabase db push
```

Review the migration list before `db push`; the new migration only adds indexes
for incremental synchronization.

## 7. Enable Pages and verify the first release

1. Under **Settings → Pages**, select **GitHub Actions** as the source.
2. Push `main` and confirm the “Deploy Mobile Web App” workflow succeeds.
3. Open the new Pages URL and verify login and Command Center data.
4. Publish the next tag using the existing release workflow.
5. Confirm the release contains one Windows installer, `latest.yml`, its blockmap,
   one universal APK, and the instructions PDF.
6. Test desktop auto-update and Android in-place update from a currently installed
   production version before retiring the old repository or Pages URL.

## Safe cutover order

Keep the old repository and Pages site available until the first build from the
new account is installed successfully. Existing desktop builds may still query
the old GitHub release feed, and existing email/status links may still target the
old Pages site. After a successful bridge release, the new build will use the new
URLs for subsequent updates.
