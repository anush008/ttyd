# Security

ttyd gives remote users a terminal. Anyone who can open a session can run the command that you start, and the command runs with the permissions of the ttyd process. Plan the deployment around that fact.

## Deployment checklist

1. Turn on authentication. Use `-c user:password`, the `TTYD_CREDENTIAL` environment variable, `-H` with an authenticating reverse proxy, or TLS client certificates (`-S -A`).
2. Put the credential in `TTYD_CREDENTIAL` instead of `-c`. ttyd reads the variable at startup and removes it from the environment, so the credential stays out of the process list and out of the child environment.
3. Turn on TLS with `-S -C cert -K key`, or terminate TLS at a reverse proxy. Basic authentication sends the password with every request.
4. Run ttyd as an unprivileged user. Start it as that user, or start it as root with `-u` (and `-g`). ttyd stops at startup if it cannot drop the privileges.
5. Bind ttyd to the interface that your users need. With `-H`, bind ttyd to `127.0.0.1` or a UNIX socket (`-i /run/ttyd.sock`), so that clients reach it only through the proxy.
6. Limit sessions with `-m`. Every session starts a new process.
7. Use `-W` only when users must type into the terminal. Without `-W`, the terminal is read-only.
8. Start a command that limits what the user can do, for example a restricted shell or a login program. Do not put secrets in the command line, because ttyd sends the command line to every client as the window title.

## Protections that ttyd turns on by default

- ttyd rejects WebSocket connections from a different origin. Use `--no-check-origin` only when a trusted reverse proxy changes the `Host` header. Use `-O` to also reject clients that send no `Origin` header.
- With `-c`, the `/token` endpoint returns a random token for each server start. The endpoint never returns the password.
- With TLS, ttyd redirects plain HTTP requests to HTTPS and rejects plain WebSocket connections.
- ttyd limits the size of client messages, and it closes a connection that sends no initial message within 30 seconds.
- ttyd ignores `-a` URL arguments that start with `-`, so clients cannot add options to the command.
- ttyd compares credentials and tokens in constant time, and it does not write them to the log.
- HTTP responses include `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. The `Server` header contains no version numbers.
- The web page reads only display options from the URL query string, for example `fontSize` and `rendererType`. Terminal output can write to the clipboard but cannot read it. The page asks before it saves a file that a ZMODEM transfer sends.

## Remaining risks

- **No authentication.** Without authentication, any client that reaches the port gets a terminal. The origin check stops other websites, but it does not stop DNS rebinding attacks against a server on `localhost`. Always turn on authentication.
- **`-H` header authentication.** ttyd checks only that the header is present. A client that reaches ttyd without the proxy can set the header itself.
- **`-a` URL arguments.** A link can start the command with arguments that the link author chooses. Use `-a` only with commands that treat every argument as data.
- **The Docker image.** The default command is `ttyd -W bash` as root, with no authentication. Always set a command and authentication for the container, for example `TTYD_CREDENTIAL=user:password` and `ttyd -W -u 1000 bash`.

## Report a vulnerability

Report security issues privately to the maintainers. Do not open a public issue.
