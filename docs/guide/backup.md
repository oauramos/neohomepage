# Backup and restore

The goal: wipe the install — new version, new machine, new container — and get the same dashboard
back.

## What to back up

`git init` the data directory. On first boot neohomepage writes a `.gitignore` there that already
excludes the two directories that must never be committed.

```sh
cd data          # or /data in the container
git init
git remote add origin git@github.com:you/neohomepage-data.git
git add -A && git commit -m "my dashboard" && git push -u origin main
```

That commits `config/` and `assets/`. It does **not** commit `secrets/` or `state/`.

`state/` is excluded because it is derived — restoring an old rendered page would just serve stale
HTML until the next publish. The app rebuilds it on boot.

`secrets/` is excluded because an API key in a git repository is an API key you have lost control
of. Encrypting it and committing the ciphertext is not good enough: a repository is copied,
mirrored and cloned, and an offline attacker gets unlimited attempts at the passphrase.

## Restoring

```sh
git clone git@github.com:you/neohomepage-data.git data
# provide your API keys (see below)
pnpm start
```

The app finds a populated `config/` and an empty `state/`, runs any migrations the config needs,
rebuilds, and serves the same dashboard. There is no import step and no wizard.

## How your API keys survive

Three options, best first.

### 1. Environment variables (recommended)

Your config only ever stores a _reference_: `{"$secret": "sonarr.apiKey"}`. The value is looked up
at request time, in this order:

1. `NEOHOMEPAGE_SECRET_SONARR_APIKEY`
2. `NEOHOMEPAGE_SECRET_SONARR_APIKEY_FILE` (a Docker secret or mounted file)
3. `secrets/secrets.json`

Put the keys in your `compose.yaml` or systemd unit — something you already keep somewhere safe —
and a restore is `git clone` plus starting the service. Nothing sensitive ever touches the
repository.

### 2. An encrypted archive, kept outside the repository

```sh
neo backup --include-secrets     # prompts for a passphrase
```

Writes a single encrypted file _outside_ the data directory, for a password manager or cold
storage. `neo restore` asks for the passphrase.

### 3. Just retype them

Restore the repository and nothing else. The dashboard comes back with every widget, target and
layout intact; widgets that need a credential show `credential unavailable` while the rest of the
page works normally. `neo doctor` prints exactly which secrets are missing and which target each
belongs to, and the editor has a **Missing credentials** panel that walks you through them.
