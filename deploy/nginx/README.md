# 4StepsVPN nginx configuration

Production nginx configuration for 4StepsVPN.

Files:

- `4stepsvpn.conf` — HTTPS virtual host, reverse proxy, security headers and API rate-limit usage.
- `4stepsvpn-ratelimit.conf` — nginx `limit_req_zone` definitions.

Before deploying on another server:

1. Check domain and certificate paths.
2. Check backend address (`127.0.0.1:3000`).
3. Install the rate-limit config into `/etc/nginx/conf.d/`.
4. Install the virtual host into the nginx sites configuration.
5. Run `nginx -t`.
6. Reload nginx only after a successful configuration test.

The application currently stays on Prisma 6.19.3 intentionally.
A Prisma 7 upgrade must be performed separately with migration,
Prisma Client, build and runtime regression testing.
