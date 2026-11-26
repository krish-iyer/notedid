# Development commands. Everything runs in Docker (Node 26) as your own user; see README.md.
#
#   make dev      start the app at http://localhost:4322 (Ctrl-C stops it)
#   make browser  build the browser-only app and serve it at http://localhost:4323 (notes stay in the browser)
#   make start    start the app in the background; `make logs` follows its output
#   make down     stop and remove the app container
#   make check    type-check, run the tests and build
#   make test     run the tests
#   make shell    open a shell in the container, e.g. for `npm install <package>`
#
# To use a real notes folder instead of ./dev-notes:  make dev NOTES_HOST_DIR=$HOME/notes

NOTES_HOST_DIR ?= ./dev-notes
export NOTES_HOST_DIR

COMPOSE := docker compose
RUN := $(COMPOSE) run --rm dev
DEPS := node_modules/.package-lock.json
SETUP := .env $(NOTES_HOST_DIR)

.PHONY: dev start logs check test typecheck build browser shell down image

dev: $(DEPS) | $(SETUP)
	$(COMPOSE) up dev

start: $(DEPS) | $(SETUP)
	$(COMPOSE) up -d dev
	@echo "notedid starting at http://localhost:$${WEB_PORT:-4322}  (make logs: follow output, make down: stop)"

logs: | .env
	$(COMPOSE) logs -f dev

check: $(DEPS) | $(SETUP)
	$(RUN) npm run check

test: $(DEPS) | $(SETUP)
	$(RUN) npm test

typecheck: $(DEPS) | $(SETUP)
	$(RUN) npm run typecheck

build: $(DEPS) | $(SETUP)
	$(RUN) npm run build

# The browser-only app: static files plus a service worker that stands in for the server.
BROWSER_PORT ?= 4323
browser: $(DEPS) | $(SETUP)
	$(COMPOSE) run --rm -p "127.0.0.1:$(BROWSER_PORT):$(BROWSER_PORT)" -e WEB_HOST=0.0.0.0 -e BROWSER_PORT=$(BROWSER_PORT) dev \
		sh -c "npm run build:browser && npm run preview:browser"

shell: | $(SETUP)
	$(RUN) bash

down: | .env
	$(COMPOSE) down

image: | .env
	$(COMPOSE) build dev

# Reinstall packages whenever package.json or the lockfile changes.
$(DEPS): package.json package-lock.json | $(SETUP)
	$(RUN) npm ci

# Containers run with your uid and gid, so the files they create belong to you,
# and in this machine's time zone, so logs and note history show local times.
.env:
	printf 'HOST_UID=%s\nHOST_GID=%s\nTZ=%s\n' "$$(id -u)" "$$(id -g)" \
		"$$(readlink /etc/localtime 2>/dev/null | sed -n 's|^.*/zoneinfo/||p' | grep . || echo UTC)" > .env

$(NOTES_HOST_DIR):
	mkdir -p "$@"
