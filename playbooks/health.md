# Homelab health check
> Quick up/down sweep of all homelab services

Check the homelab. Use `HOMELAB.md` for the service list. For each service:

1. `curl -sf -o /dev/null -m 3 <localhost-url>` and report up/down.
2. If down, peek at the docker container — `docker ps --filter "name=<container>" --format '{{.Status}}'`.

Group the report:
- ✅ Up: comma-separated list of names
- ❌ Down: one line each with status

Keep it under 6 lines total. If everything's up: just "✅ everything up".
