# Security policy — Messa 0.1

## Supported scope

This is a single-process, self-hosted messenger for a small, trusted community. It has not received an independent penetration test or cryptographic audit. Do not use it for high-risk communications or an unrestricted public network.

**No end-to-end encryption.** The server, its operator and anyone who obtains an unencrypted backup can read message bodies and files. TLS does not change this trust model. There are no fake encryption badges or client-side password claims.

## Implemented controls

- Async scrypt passwords: N=32768, r=8, p=1; 16-byte random salt and 64-byte result. At most four concurrent hashes. Password length 12–128 characters. Unknown-user login also performs scrypt.
- Random 256-bit opaque session tokens. Only SHA-256 token hashes are stored. Seven-day absolute expiration, five sessions per user, explicit logout and logout-all.
- HttpOnly / SameSite=Strict cookies; Secure and `__Host-` prefix in production. Tokens never enter localStorage. Authenticated mutations require a per-session CSRF token plus exact configured Origin. Cross-site Fetch Metadata is rejected.
- Membership checks on **every** conversation, message, typing, read-receipt and attachment endpoint. Modification of messages is author-only; group renaming is owner-only.
- Bound prepared SQL statements, strict schema, foreign keys, unique idempotency keys and transactions. Unicode search treats input as data, not SQL or a regular expression.
- Message rendering escapes markup; links allow only HTTP(S), use noopener/noreferrer, and no unsafe inline handlers. CSP blocks inline script, plugins, framing, external fonts and external connections. Server returns nosniff, no-referrer, same-origin resource policy, and production HSTS.
- API and attachment responses use no-store. Service worker has an explicit public-asset allowlist, never a generic caching rule.
- Global/IP/account/user rate limits; 32 KB JSON body cap, 4000-character messages, 10 MB files, four concurrent uploads, 200 MB user upload quota, 5 GB aggregate upload quota. Request/header timeouts and response backpressure limits.
- Uploaded paths use random UUIDs, not supplied filenames. MIME is detected from safe image signatures; SVG/HTML are downloaded as inert attachments. Even safe images are only inline on explicit preview requests. This is **not an antivirus or a full image decoder**.
- Orphaned uploads expire after 24 hours; metadata cleanup runs once a minute. Message deletion removes attached files. Soft-deleted message rows retain IDs and timestamps for stable synchronization. Backups can retain old copies.
- Presence is shared only with people in common chats. Searchable usernames and profile fields are visible to other authenticated users. Message authors/readers are visible to members.

## Operational responsibilities

- Use HTTPS, a closed registration policy and a genuinely random invitation code shared out of band. Do not commit credentials.
- Keep Node and browser security updates current; test upgrades before rollout. The pinned container versions are reproducibility baselines, not permanent security guarantees.
- Encrypt the host disk and backup storage; restrict access to the data directory. Docker image runs without root, with a read-only application filesystem and a writable data volume.
- Only expose the reverse proxy. The app intentionally ignores forwarded IP headers. Behind a proxy, IP-based quotas are shared by its users. Revisit trusted-proxy handling and abuse limits before opening a public service.
- Keep the application at the domain root. Do not deploy multiple instances against one SQLite file. SSE delivery and ephemeral presence are process-local.
- There is no recovery email, MFA, account deletion UI, block/report flow or malicious-file scanner yet. The file download boundary does not make a downloaded file safe to open.
- Session drafts and the unsent outbox contain plaintext in the current browser tab. Explicit logout clears them. Session expiration retains them under the old account's key for recovery on re-login; use a private browser profile on shared devices.
- Backups are offline operations; test a restore, not only a successful backup command. Delete exported artifacts according to your retention policy.

## Reporting a vulnerability

Do **not** publish passwords, conversation content, invitation codes or exploit details in a public issue. Contact the repository owner privately through a channel you already trust. Until a dedicated private reporting address is configured, open only a content-free issue asking for a private security contact.

Provide affected version, reproduction with synthetic accounts, expected/actual behavior and impact. Avoid testing systems you do not own.
