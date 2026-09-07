# Signing in

neohomepage is **open to read and authenticated to change**. A start page you open fifty times a
day should not ask for a password; the write API is a different matter, because a stray cross-site
POST is how an attacker re-points your Sonarr widget at their server. The realistic attacker here
is your own browser visiting any website, which is exactly why Chrome is shipping Local Network
Access prompts.

## A password

```yaml
environment:
  NEOHOMEPAGE_USERNAME: neo
  NEOHOMEPAGE_PASSWORD: something-long-and-boring
```

Set both and password mode turns on. The session cookie is signed with a key derived from the
password itself, which has two useful consequences: sessions survive a restart, and changing the
password signs everyone out with nothing to purge.

## Behind Authelia, Authentik or Tailscale

```yaml
environment:
  NEOHOMEPAGE_AUTH_MODE: forward
  NEOHOMEPAGE_TRUSTED_PROXIES: 10.0.0.2,192.168.1.0/24
```

The app then trusts `Remote-User` (or `X-Forwarded-User`) — but only from a peer in that list, and
only by its real socket address. It **refuses to start** without the list, because believing an
identity header from anyone who can reach the port is worse than no authentication at all: it looks
like authentication.

## No authentication

Leave the variables unset. Reads and writes are both open. The cross-site protections below stay on
regardless, because they cost nothing and the attack they stop does not care whether you have a
password.

## What is always on

- `Sec-Fetch-Site` must be `same-origin` for any write, with an `Origin` check as a fallback.
- Writes must be `application/json`, which a plain cross-site form post cannot be.
- No GET changes anything.
